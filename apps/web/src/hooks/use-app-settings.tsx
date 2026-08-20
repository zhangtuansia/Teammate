"use client";

import { createContext, useContext } from "react";

export type AppLanguage = "zh-CN" | "en-US";
export type AppTheme = "system" | "light" | "dark";
export type AgentModel = "opus" | "sonnet" | "haiku";

export interface AppSettings {
  language: AppLanguage;
  theme: AppTheme;
  defaultModel: AgentModel;
  provider: "claude-code";
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
  "settings.provider": "Provider",
  "settings.providerClaude": "Claude Code (current runner)",
  "settings.defaultModel": "Default model",
  "settings.modelOpus": "Opus — Most capable",
  "settings.modelSonnet": "Sonnet — Balanced",
  "settings.modelHaiku": "Haiku — Fastest",
  "settings.modelHint": "Used when creating new agents. Existing agents keep their own model setting.",
  "settings.providerHint": "Codex and OpenAI-compatible endpoints are not connected yet; this screen reports the runner actually in use.",
  "settings.cancel": "Cancel",
  "settings.save": "Save settings",
  "settings.saving": "Saving…",
  "createAgent.title": "Create Agent",
  "createAgent.description": "Add a new AI agent to your workspace.",
  "createAgent.name": "Name",
  "createAgent.namePlaceholder": "e.g. Design Assistant, Code Reviewer…",
  "createAgent.descriptionField": "Description",
  "createAgent.descriptionPlaceholder": "What does this agent do?",
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

type TranslationKey = keyof typeof en;

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
  "settings.provider": "提供方",
  "settings.providerClaude": "Claude Code（当前运行器）",
  "settings.defaultModel": "默认模型",
  "settings.modelOpus": "Opus — 能力最强",
  "settings.modelSonnet": "Sonnet — 均衡",
  "settings.modelHaiku": "Haiku — 最快",
  "settings.modelHint": "新建智能体时使用。已有智能体继续保留各自的模型设置。",
  "settings.providerHint": "Codex 和 OpenAI 兼容接口尚未接入；这里会如实显示当前真正使用的运行器。",
  "settings.cancel": "取消",
  "settings.save": "保存设置",
  "settings.saving": "保存中…",
  "createAgent.title": "新建智能体",
  "createAgent.description": "向工作区添加一个新的 AI 智能体。",
  "createAgent.name": "名称",
  "createAgent.namePlaceholder": "例如：设计助手、代码审查员…",
  "createAgent.descriptionField": "描述",
  "createAgent.descriptionPlaceholder": "这个智能体负责什么？",
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
  defaultModel: "opus",
  provider: "claude-code",
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
