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

async function generateChangesMessage(sourceRepoPath, currentTag) {
    core.info('Generating changes for commit message...');
    process.chdir(sourceRepoPath);

    const { stdout: latestTargetTag } = await runCommand('git describe --tags --abbrev=0', { ignoreReturnCode: true, silent: true });

    let tagRange = '';
    if (latestTargetTag) {
        const { stdout: tagExistsInSource } = await runCommand(`git tag --list ${latestTargetTag}`);
        if (tagExistsInSource.trim() === latestTargetTag) {
            core.info(`Found latest target tag "${latestTargetTag}" in source. Creating log from that tag.`);
            tagRange = `${latestTargetTag}..${currentTag}`;
        }
    }

    if (!tagRange) {
        core.info('Could not find a common tag. Using latest commit message from source.');
        const { stdout } = await runCommand(`git log -1 --pretty=%s ${currentTag}`);
        return stdout;
    }

    const { stdout: hashes } = await runCommand(`git log --pretty=%H ${tagRange}`);
    if (!hashes) {
        core.info('No new commits found in range. Using latest commit message.');
        const { stdout } = await runCommand(`git log -1 --pretty=%s ${currentTag}`);
        return stdout;
    }

    const messages = [];
    for (const hash of hashes.split('\n').filter(h => h)) {
        const { stdout: parentCount } = await runCommand(`git rev-list --count -1 --parents ${hash}`);
        const isMerge = parseInt(parentCount.split(' ')[0], 10) > 1;

        if (isMerge) {
            core.info(`Expanding messages from merge commit ${hash}`);
            const { stdout: mergeMessages } = await runCommand(`git log --pretty=%s ${hash}^1..${hash}^2`);
            messages.push(...mergeMessages.split('\n').filter(Boolean));
        } else {
            const { stdout: message } = await runCommand(`git log -1 --pretty=%s ${hash}`);
            messages.push(message);
        }
    }

    return messages.join('\n');
}

async function run() {
    try {
        const repoUrls = core.getMultilineInput('repos', { required: true });
        const syncListFile = core.getInput('sync_list', { required: true });
        const currentTag = core.getInput('tag', { required: true });

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

            const changes = await generateChangesMessage(targetRepoPath, currentTag);
            core.setOutput('changes', changes);
            process.chdir(targetRepoPath);

            core.info('Syncing files...');
            for (const item of filesToSync) {
                const srcPath = path.join(sourceRepoPath, item);
                const destPath = path.join(targetRepoPath, item);
                await fse.copy(srcPath, destPath, { overwrite: true });
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
