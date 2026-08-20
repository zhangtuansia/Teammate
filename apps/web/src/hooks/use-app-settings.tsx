"use client";

import { createContext, useContext } from "react";
import type { AgentRuntimeId } from "@/lib/agent-runtime";

export type AppLanguage = "zh-CN" | "en-US";
export type AppTheme = "system" | "light" | "dark";
export type AgentModel = string;
export type AgentRuntime = AgentRuntimeId;

export interface AppSettings {
  language: AppLanguage;
  theme: AppTheme;
  defaultRuntime: AgentRuntime;
  defaultModel: AgentModel;
  defaultConnectionId: string | null;
}

const en = {
  "nav.agents": "Agents",
  "nav.channels": "Channels",
  "nav.machines": "Machines",
  "nav.createAgent": "Create agent",
  "nav.createChannel": "Create channel",
  "nav.settings": "Settings",
  "workspace.agents": "Agents",
  "workspace.channels": "Channels",
  "workspace.members": "Members",
  "workspace.description": "Runs entirely on this computer with Node and SQLite.",
  "workspace.prompt": "Choose an agent or channel from the sidebar to start collaborating.",
  "runtime.starting": "Starting local workspace…",
  "runtime.error": "Teammate runtime failed to start",
  "runtime.retry": "Retry",
  "conversation.loading": "Loading conversation…",
  "conversation.select": "Select a conversation to start chatting",
  "message.loadingOlder": "Loading older messages…",
  "message.beginning": "Beginning of conversation",
  "message.system": "System",
  "message.agent": "Agent",
  "message.you": "You",
  "message.agentBadge": "agent",
  "message.thinking": "Thinking",
  "message.working": "Working",
  "message.send": "Send",
  "message.sending": "Sending…",
  "message.agentPlaceholder": "Message {name}…",
  "message.channelPlaceholder": "@ to mention an agent in #{name}…",
  "message.agentSettings": "Agent settings",
  "settings.title": "Settings",
  "settings.description": "Customize Teammate on this computer.",
  "settings.interface": "Interface",
  "settings.language": "Language",
  "settings.languageZh": "简体中文",
  "settings.languageEn": "English",
  "settings.appearance": "Appearance",
  "settings.themeSystem": "Follow system",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.agentRuntime": "Agent runtime",
  "settings.runtime": "Default runtime",
  "settings.runtimeClaude": "Claude Code",
  "settings.runtimeCodex": "Codex",
  "settings.runtimePi": "Pi / Custom API",
  "settings.defaultModel": "Default model",
  "settings.modelOpus": "Opus — Most capable",
  "settings.modelSonnet": "Sonnet — Balanced",
  "settings.modelHaiku": "Haiku — Fastest",
  "settings.modelCodexDefault": "Use Codex default",
  "settings.runtimeInstalled": "Installed",
  "settings.runtimeMissing": "CLI not found",
  "settings.codexModelPlaceholder": "default or a Codex model ID",
  "settings.modelHint": "Used when creating new agents. Existing agents keep their own model setting.",
  "settings.runtimeHint": "Claude Code and Codex use their installed CLI and existing local login.",
  "settings.connections": "Model connections",
  "settings.connectionsHint": "Keys and OAuth tokens are encrypted on this computer and never stored in SQLite.",
  "settings.chatGptOAuth": "ChatGPT Plus / Pro",
  "settings.chatGptOAuthHint": "Use your Codex subscription through a secure browser sign-in.",
  "settings.connect": "Connect",
  "settings.connecting": "Waiting for sign-in…",
  "settings.connected": "Connected",
  "settings.addApi": "Add custom API",
  "settings.connectionName": "Connection name",
  "settings.provider": "API protocol",
  "settings.baseUrl": "Base URL",
  "settings.apiKey": "API key",
  "settings.connectionModel": "Model ID",
  "settings.addConnection": "Save connection",
  "settings.removeConnection": "Remove",
  "settings.chooseConnection": "Model connection",
  "settings.cancel": "Cancel",
  "settings.save": "Save settings",
  "settings.saving": "Saving…",
  "createAgent.title": "Create Agent",
  "createAgent.description": "Add a new AI agent to your workspace.",
  "createAgent.name": "Name",
  "createAgent.namePlaceholder": "e.g. Design Assistant, Code Reviewer…",
  "createAgent.descriptionField": "Description",
  "createAgent.descriptionPlaceholder": "What does this agent do?",
  "createAgent.runtime": "Runtime",
  "createAgent.model": "Model",
  "createAgent.instructions": "Instructions",
  "createAgent.instructionsPlaceholder": "Tell the agent how to behave, what it is good at, and what tools to use…",
  "createAgent.optional": "optional",
  "createAgent.cancel": "Cancel",
  "createAgent.submit": "Create Agent",
  "createChannel.title": "Create Channel",
  "createChannel.description": "Create a new group channel for your workspace.",
  "createChannel.name": "Channel name",
  "createChannel.namePlaceholder": "e.g. design, marketing, dev…",
  "createChannel.descriptionField": "Description",
  "createChannel.descriptionPlaceholder": "What is this channel about?",
  "createChannel.invite": "Invite agents",
  "createChannel.optional": "optional",
  "createChannel.cancel": "Cancel",
  "createChannel.submit": "Create Channel",
} as const;

export type TranslationKey = keyof typeof en;

const zh: Record<TranslationKey, string> = {
  "nav.agents": "智能体",
  "nav.channels": "频道",
  "nav.machines": "设备",
  "nav.createAgent": "新建智能体",
  "nav.createChannel": "新建频道",
  "nav.settings": "设置",
  "workspace.agents": "智能体",
  "workspace.channels": "频道",
  "workspace.members": "成员",
  "workspace.description": "完全运行在本机，使用 Node 和 SQLite。",
  "workspace.prompt": "从左侧选择一个智能体或频道开始协作。",
  "runtime.starting": "正在启动本地工作区…",
  "runtime.error": "Teammate 本地运行时启动失败",
  "runtime.retry": "重试",
  "conversation.loading": "正在加载会话…",
  "conversation.select": "选择一个会话开始聊天",
  "message.loadingOlder": "正在加载更早的消息…",
  "message.beginning": "会话开始",
  "message.system": "系统",
  "message.agent": "智能体",
  "message.you": "你",
  "message.agentBadge": "智能体",
  "message.thinking": "思考中",
  "message.working": "工作中",
  "message.send": "发送",
  "message.sending": "发送中…",
  "message.agentPlaceholder": "给 {name} 发消息…",
  "message.channelPlaceholder": "输入 @ 在 #{name} 中提及智能体…",
  "message.agentSettings": "智能体设置",
  "settings.title": "设置",
  "settings.description": "自定义这台电脑上的 Teammate。",
  "settings.interface": "界面",
  "settings.language": "语言",
  "settings.languageZh": "简体中文",
  "settings.languageEn": "English",
  "settings.appearance": "外观",
  "settings.themeSystem": "跟随系统",
  "settings.themeLight": "浅色",
  "settings.themeDark": "深色",
  "settings.agentRuntime": "智能体运行时",
  "settings.runtime": "默认运行引擎",
  "settings.runtimeClaude": "Claude Code",
  "settings.runtimeCodex": "Codex",
  "settings.runtimePi": "Pi / 自定义 API",
  "settings.defaultModel": "默认模型",
  "settings.modelOpus": "Opus — 能力最强",
  "settings.modelSonnet": "Sonnet — 均衡",
  "settings.modelHaiku": "Haiku — 最快",
  "settings.modelCodexDefault": "使用 Codex 默认模型",
  "settings.runtimeInstalled": "已安装",
  "settings.runtimeMissing": "未找到 CLI",
  "settings.codexModelPlaceholder": "default 或 Codex 模型 ID",
  "settings.modelHint": "新建智能体时使用。已有智能体继续保留各自的模型设置。",
  "settings.runtimeHint": "Claude Code 和 Codex 使用本机已安装的 CLI 与现有登录状态。",
  "settings.connections": "模型连接",
  "settings.connectionsHint": "Key 与 OAuth Token 只会加密保存在这台电脑，不会写入 SQLite。",
  "settings.chatGptOAuth": "ChatGPT Plus / Pro",
  "settings.chatGptOAuthHint": "通过浏览器安全登录，使用你的 Codex 订阅。",
  "settings.connect": "连接",
  "settings.connecting": "等待登录…",
  "settings.connected": "已连接",
  "settings.addApi": "添加自定义 API",
  "settings.connectionName": "连接名称",
  "settings.provider": "API 协议",
  "settings.baseUrl": "Base URL",
  "settings.apiKey": "API Key",
  "settings.connectionModel": "模型 ID",
  "settings.addConnection": "保存连接",
  "settings.removeConnection": "移除",
  "settings.chooseConnection": "模型连接",
  "settings.cancel": "取消",
  "settings.save": "保存设置",
  "settings.saving": "保存中…",
  "createAgent.title": "新建智能体",
  "createAgent.description": "向工作区添加一个新的 AI 智能体。",
  "createAgent.name": "名称",
  "createAgent.namePlaceholder": "例如：设计助手、代码审查员…",
  "createAgent.descriptionField": "描述",
  "createAgent.descriptionPlaceholder": "这个智能体负责什么？",
  "createAgent.runtime": "运行引擎",
  "createAgent.model": "模型",
  "createAgent.instructions": "指令",
  "createAgent.instructionsPlaceholder": "告诉智能体应该如何工作、擅长什么、使用哪些工具…",
  "createAgent.optional": "可选",
  "createAgent.cancel": "取消",
  "createAgent.submit": "创建智能体",
  "createChannel.title": "新建频道",
  "createChannel.description": "为工作区创建一个多人协作频道。",
  "createChannel.name": "频道名称",
  "createChannel.namePlaceholder": "例如：设计、市场、开发…",
  "createChannel.descriptionField": "描述",
  "createChannel.descriptionPlaceholder": "这个频道用于讨论什么？",
  "createChannel.invite": "邀请智能体",
  "createChannel.optional": "可选",
  "createChannel.cancel": "取消",
  "createChannel.submit": "创建频道",
};

export const defaultAppSettings: AppSettings = {
  language: "en-US",
  theme: "system",
  defaultRuntime: "claude-code",
  defaultModel: "sonnet",
  defaultConnectionId: null,
};

export function translate(
  language: AppLanguage,
  key: TranslationKey,
  values?: Record<string, string>,
) {
  let result = (language === "zh-CN" ? zh : en)[key];
  for (const [name, value] of Object.entries(values || {})) {
    result = result.replaceAll(`{${name}}`, value);
  }
  return result;
}

export interface AppSettingsContextValue {
  settings: AppSettings;
  t: (key: TranslationKey, values?: Record<string, string>) => string;
  openSettings?: () => void;
}

export const AppSettingsContext = createContext<AppSettingsContextValue>({
  settings: defaultAppSettings,
  t: (key, values) => translate(defaultAppSettings.language, key, values),
});

export function useAppSettings() {
  return useContext(AppSettingsContext);
}
