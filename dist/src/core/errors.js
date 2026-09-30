/** 所有可预期错误都抛 GodotMcpError,带稳定错误码。 */
export class GodotMcpError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "GodotMcpError";
        this.code = code;
        this.details = details;
    }
}
