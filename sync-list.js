function parseSyncList(content) {
    return content
        .split(/\r?\n|\r/)
        .map(line => line.trim())
        .filter(Boolean);
}

module.exports = { parseSyncList };
