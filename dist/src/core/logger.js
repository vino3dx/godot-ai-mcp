const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(level = process.env["GODOT_AI_MCP_LOG"] ?? "info", sink = (l) => { process.stderr.write(l + "\n"); }) {
    const min = ORDER[level] ?? ORDER.info;
    const emit = (lv) => (msg, meta) => {
        if (ORDER[lv] < min)
            return;
        sink(`[godot-ai-mcp] ${lv.toUpperCase()} ${msg}${meta === undefined ? "" : " " + JSON.stringify(meta)}`);
    };
    return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
