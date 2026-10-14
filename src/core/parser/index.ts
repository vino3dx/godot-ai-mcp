// Core 解析器统一出口。纯函数:不 import 文件系统 / Node 原生模块,也不 import MCP。

export type {
  GodotLineEnding,
  GodotConfigAST,
  GodotConfigSection,
  GodotConfigEntry,
  GodotConfigKeyEntry,
  GodotConfigPassthroughEntry,
  GodotResourceAST,
  GodotResourceTag,
  GodotResourceSection,
  GodotResourceAttribute,
  GodotResourceBodyEntry,
  GodotResourceProperty,
  GodotResourcePassthrough,
  GodotNodeAST,
} from "./types.js";

export type { Literal, LiteralChange } from "./literal.js";

export { parseGodotLiteral, toLiteral, literalChange } from "./literal.js";

export {
  parseGodotConfigFile,
  serializeGodotConfigFile,
  getGodotConfigValue,
  setGodotConfigValue,
} from "./godotConfig.js";

export {
  parseGodotResource,
  serializeGodotResource,
  findGodotResourceSections,
  getGodotResourceProperty,
  setGodotResourceProperty,
  getGodotSceneNodes,
} from "./godotResource.js";
