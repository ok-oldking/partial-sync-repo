// index.js
const core = require('@actions/core');
const exec = require('@actions/exec');
const fse = require('fs-extra');
const path = require('path');

async function runCommand(command, options = {}) {
    let stdout = '';
    let stderr = '';

    const execOptions = {
        ...options,
        listeners: {
            stdout: (data) => {
                stdout += data.toString();
            },
            stderr: (data) => {
                stderr += data.toString();
            },
        },
    };

    const exitCode = await exec.exec(command, [], execOptions);

    if (exitCode !== 0 && !execOptions.ignoreReturnCode) {
        throw new Error(`Command "${command}" failed with exit code ${exitCode}:\n${stderr}`);
    }

    return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function generateChangesMessage(sourceRepoPath, targetRepoPath, currentTag, showAuthor) {
    core.info('Generating changes for commit message...');

    process.chdir(targetRepoPath);
    const { stdout: latestTargetTag } = await runCommand('git describe --tags --abbrev=0', { ignoreReturnCode: true, silent: true });
    process.chdir(sourceRepoPath);

    let startTag = '';
    let messages = '';

    if (latestTargetTag) {
        const { stdout: tagExistsInSource } = await runCommand(`git tag --list ${latestTargetTag}`);
        if (tagExistsInSource.trim() === latestTargetTag) {
            core.info(`Found latest target tag "${latestTargetTag}" in source. Creating log from that tag.`);
            startTag = latestTargetTag;
            const tagRange = `${startTag}..${currentTag}`;
            const logFormat = showAuthor ? '--pretty=format:"%s (%an)"' : '--pretty=format:"%s"';
            const { stdout } = await runCommand(`git log --no-merges ${logFormat} ${tagRange}`, { ignoreReturnCode: true });
            messages = stdout;
        }
    }

    if (!messages) {
        core.info('Could not find a common tag or no new commits in range. Using latest commit message.');
        const { stdout } = await runCommand(`git log -1 --pretty=%s ${currentTag}`);
        return { messages: stdout, startTag: '' };
    }

    const uniqueLines = [...new Set(messages.split('\n'))];
    messages = uniqueLines.join('\n');

    return { messages, startTag };
}

async function run() {
    try {
        const repoUrls = core.getMultilineInput('repos', { required: true });
        const syncListFile = core.getInput('sync_list', { required: true });
        const currentTag = core.getInput('tag', { required: true });
        const gitignoreFile = core.getInput('gitignore_file');
        const showAuthor = core.getBooleanInput('show_author');

        core.setOutput('end_tag', currentTag);
        core.setOutput('start_tag', '');

        const sourceRepoPath = process.cwd();
        const syncListPath = path.join(sourceRepoPath, syncListFile);

        if (!fse.existsSync(syncListPath)) {
            throw new Error(`Sync list file not found at: ${syncListPath}`);
        }
        const filesToSync = fse.readFileSync(syncListPath, 'utf8').split('\n').filter(line => line.trim() !== '');

        core.info(`Source Repo Path: ${sourceRepoPath}`);
        core.info(`Syncing tag: ${currentTag}`);
        core.info(`Files to sync: ${filesToSync.join(', ')}`);

        process.chdir(sourceRepoPath);
        const { stdout: sourceCommit } = await runCommand(`git rev-parse ${currentTag}^{commit}`);
        const { stdout: sourceTagsRaw } = await runCommand('git tag');
        const sourceTags = new Set(sourceTagsRaw.split('\n').filter(Boolean));
        const { stdout: specialTagsRaw } = await runCommand(`git tag --points-at ${sourceCommit}`);
        const specialTags = specialTagsRaw.split('\n').filter(t => t && t !== currentTag);

        for (const repoUrl of repoUrls) {
            const repoName = path.basename(repoUrl, '.git');
            const targetRepoPath = path.join(sourceRepoPath, '..', `target_${repoName}`);

            core.info(`\n--- Processing repository: ${repoUrl} ---`);
            await fse.remove(targetRepoPath);
            await runCommand(`git clone ${repoUrl} ${targetRepoPath}`);

            const { messages: changes, startTag } = await generateChangesMessage(sourceRepoPath, targetRepoPath, currentTag, showAuthor);
            const changes_with_asterisk = changes.split('\n').filter(line => line).map(line => `* ${line}`).join('\n');
            core.setOutput('changes', changes);
            core.setOutput('changes_with_asterisk', changes_with_asterisk);
            core.setOutput('start_tag', startTag);
            process.chdir(targetRepoPath);

            core.info('Syncing files...');
            for (const item of filesToSync) {
                const srcPath = path.join(sourceRepoPath, item);
                const destPath = path.join(targetRepoPath, item);

                if (await fse.pathExists(srcPath)) {
                    const stats = await fse.stat(srcPath);
                    if (stats.isDirectory()) {
                        await fse.remove(destPath);
                    }
                    await fse.copy(srcPath, destPath, { overwrite: true });
                } else {
                    core.info(`Source item '${item}' not found, ensuring it's removed from target.`);
                    await fse.remove(destPath);
                }
            }

            if (gitignoreFile) {
                const gitignoreSourcePath = path.join(sourceRepoPath, gitignoreFile);
                if (await fse.pathExists(gitignoreSourcePath)) {
                    const gitignoreDestPath = path.join(targetRepoPath, '.gitignore');
                    core.info(`Copying ${gitignoreFile} to ${gitignoreDestPath}`);
                    await fse.copy(gitignoreSourcePath, gitignoreDestPath, { overwrite: true });
                } else {
                    core.warning(`Optional gitignore_file '${gitignoreFile}' not found. Skipping.`);
                }
            }

            await runCommand('git add .');
            const commitResult = await runCommand(`git commit -m "${changes}"`, { ignoreReturnCode: true });
            if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
                core.info('No file changes to commit.');
            } else {
                core.info('Changes committed.');
            }

            core.info('Synchronizing tags...');
            const { stdout: targetTagsRaw } = await runCommand('git tag');
            const targetTags = new Set(targetTagsRaw.split('\n').filter(Boolean));

            for (const tag of targetTags) {
                if (!sourceTags.has(tag)) {
                    core.info(`Deleting tag "${tag}" from target repo as it does not exist in source.`);
                    await runCommand(`git push origin --delete ${tag}`, { ignoreReturnCode: true });
                }
            }

            core.info(`Applying current version tag: ${currentTag}`);
            await runCommand(`git tag -af ${currentTag} -m "${changes}"`);

            if (specialTags.length > 0) {
                core.info(`Applying special tags: ${specialTags.join(', ')}`);
                for (const tag of specialTags) {
                    await runCommand(`git tag -f ${tag} ${currentTag}`);
                }
            }

            const { stdout: mainBranch } = await runCommand('git rev-parse --abbrev-ref HEAD');
            core.info(`Pushing branch "${mainBranch}" and all tags...`);
            await runCommand(`git push origin ${mainBranch} --force`);
            await runCommand('git push origin --tags --force');
        }

        core.info('\nOperation completed successfully for all repositories.');

    } catch (error) {
        core.setFailed(error.message);
    }
}

run();