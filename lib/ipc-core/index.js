/**
 * `dsh-interpersonal-circumplex` 的纯逻辑核心。
 *
 * 这一层不 import 任何 DSH 包、不碰文件系统、不碰网络，因此可以在 node 里直接单测，
 * 也可以被 host 插件与浏览器半边同时复用。
 *
 * 模块分层：
 *
 * - `circumplex.js` —— 环形几何、8 个分仪、121 个格子、四种关系原型与全套关系度量。
 * - `lexicon.js`   —— 单方姿态词表（33 条，带出处分级）与强度分档。
 * - `states.js`    —— 关系状态词表（文献里的中文关系维度名）与按读数选词。
 * - `match.js`     —— 坐标 ↔ 语言的唯一转换点。
 * - `dynamics.js`  —— 惯性、非互补升级、网格+残差量化（无时间项）。
 * - `state.js`     —— 会话级双人状态机（含历史、转写、开关集合、持久化）。
 * - `appraise.js`  —— 对话 → 两个坐标的打分提示词与解析器。
 * - `describe.js`  —— 把度量渲染成提示词块、行为指引与日志摘要。
 *
 * @module dsh-interpersonal-circumplex/core
 */

export * from './circumplex.js';
export * from './lexicon.js';
export * from './states.js';
export * from './match.js';
export * from './dynamics.js';
export * from './describe.js';
export * from './appraise.js';
export { InterpersonalStore, KEY_SEPARATOR, dyadKey, parseDyadKey } from './state.js';
