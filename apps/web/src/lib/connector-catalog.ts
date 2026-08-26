/**
 * The connectors you can add without knowing what to type.
 *
 * The panel this feeds started as a list of what you had already configured,
 * which is only useful once you know a connector exists and what command runs
 * it. Doubao's 技能·连接器 page answers the earlier question instead — it is a
 * catalogue, browsable by category, where adding something is one click and the
 * command is the catalogue's problem rather than yours.
 *
 * Their list splits in two, and only the second half is out of reach. 高德 and
 * Tushare publish real MCP servers to npm and are here; 钉钉 has a third-party
 * one. What is missing — 巨量引擎, 天眼查, 同花顺, Wind — has no public package
 * at all, because those are remote endpoints Doubao reaches over HTTP. Its
 * helper speaks STDIO, authorized HTTP and legacy HTTP+SSE; app_connectors
 * stores a command and arguments and nothing else, so a URL has nowhere to go.
 * That is a gap in this model rather than a fact about those services.
 *
 * 企业微信 is the odd one: @wecom/cli is real and official but is a CLI, not an
 * MCP server — the wrapper that makes it one is Doubao's own.
 *
 * Every entry was checked against the npm registry rather than remembered; a
 * catalogue that offers a package which 404s is worse than no catalogue. npx
 * only, for the same reason: uvx entries need Python tooling present, and an
 * entry that cannot run on a stock machine is the same broken promise.
 */

export type ConnectorCategory =
  | "featured"
  | "dev"
  | "web"
  | "team"
  | "finance"
  | "thinking";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  categories: ConnectorCategory[];
  /**
   * Local servers are spawned; remote ones are called. Absent means stdio,
   * which is what every entry below happens to be — the field exists because
   * the model now carries it, not because the catalogue needs it yet.
   */
  transport?: "stdio" | "http" | "sse";
  /** Remote only. The endpoint the runtime talks to. */
  url?: string;
  command: string;
  args: string[];
  /**
   * Environment variables the server needs before it can do anything. Listed so
   * the panel can say what a connector will ask for rather than letting it fail
   * on first use with nothing to explain why.
   */
  requires?: { key: string; label: string }[];
  /**
   * A path or connection string the person has to supply. Kept apart from
   * `requires` because it goes in the argument list, not the environment.
   */
  argument?: { label: string; placeholder: string };
  /** Two letters for the tile, since these have no icons we may redistribute. */
  initials: string;
  tint: string;
}

export const CONNECTOR_CATEGORIES: { id: ConnectorCategory; label: string }[] = [
  { id: "featured", label: "精选" },
  { id: "dev", label: "开发" },
  { id: "web", label: "浏览" },
  { id: "team", label: "协作" },
  { id: "finance", label: "金融" },
  { id: "thinking", label: "思考" },
];

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    argument: { label: "可访问的目录", placeholder: "/Users/you/Documents" },
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    categories: ["featured", "dev"],
    command: "npx",
    description: "读写指定目录下的文件，范围仅限你授权的路径。",
    id: "filesystem",
    initials: "FS",
    name: "文件系统",
    tint: "#e8a33d",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-github"],
    categories: ["featured", "dev"],
    command: "npx",
    description: "查阅仓库、议题与 PR，检索代码。",
    id: "github",
    initials: "GH",
    name: "GitHub",
    requires: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "个人访问令牌" }],
    tint: "#24292f",
  },
  {
    argument: { label: "连接串", placeholder: "postgresql://localhost/mydb" },
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    categories: ["dev"],
    command: "npx",
    description: "只读查询 Postgres，并可读取表结构。",
    id: "postgres",
    initials: "PG",
    name: "Postgres",
    tint: "#31648c",
  },
  {
    args: ["-y", "@playwright/mcp@latest"],
    categories: ["featured", "web"],
    command: "npx",
    description: "驱动真实浏览器：打开页面、点击、填表、取内容。",
    id: "playwright",
    initials: "PW",
    name: "Playwright 浏览器",
    tint: "#2ead33",
  },
  {
    args: ["-y", "chrome-devtools-mcp@latest"],
    categories: ["web", "dev"],
    command: "npx",
    description: "接上 Chrome 调试协议，查网络请求、控制台与性能。",
    id: "chrome-devtools",
    initials: "CD",
    name: "Chrome DevTools",
    tint: "#4285f4",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    categories: ["web"],
    command: "npx",
    description: "无头浏览器抓页面、截图。",
    id: "puppeteer",
    initials: "PP",
    name: "Puppeteer",
    tint: "#01d1a1",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    categories: ["web"],
    command: "npx",
    description: "用 Brave 搜索网页与本地商户。",
    id: "brave-search",
    initials: "BR",
    name: "Brave 搜索",
    requires: [{ key: "BRAVE_API_KEY", label: "API Key" }],
    tint: "#fb542b",
  },
  {
    args: ["-y", "@notionhq/notion-mcp-server"],
    categories: ["featured", "team"],
    command: "npx",
    description: "查找、读取与整理 Notion 里的页面和数据库。",
    id: "notion",
    initials: "NO",
    name: "Notion",
    requires: [{ key: "NOTION_TOKEN", label: "集成令牌" }],
    tint: "#111111",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-slack"],
    categories: ["team"],
    command: "npx",
    description: "读取频道与消息，在 Slack 里收发。",
    id: "slack",
    initials: "SL",
    name: "Slack",
    requires: [
      { key: "SLACK_BOT_TOKEN", label: "Bot Token" },
      { key: "SLACK_TEAM_ID", label: "Team ID" },
    ],
    tint: "#611f69",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-memory"],
    categories: ["featured", "thinking"],
    command: "npx",
    description: "把事实记进知识图谱，跨会话调用。",
    id: "memory",
    initials: "ME",
    name: "记忆",
    tint: "#7c6cf0",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    categories: ["thinking"],
    command: "npx",
    description: "把难题拆成可以回头修正的思考步骤。",
    id: "sequential-thinking",
    initials: "SQ",
    name: "循序思考",
    tint: "#0f9d8f",
  },
  {
    args: ["-y", "@modelcontextprotocol/server-everything"],
    categories: ["dev"],
    command: "npx",
    description: "官方示例服务，用来验证连接器是否接通。",
    id: "everything",
    initials: "EV",
    name: "示例服务",
    tint: "#8a8a8a",
  },
  {
    args: ["-y", "@larksuiteoapi/lark-mcp", "mcp", "-m", "preset.default"],
    categories: ["featured", "team"],
    command: "npx",
    description: "飞书官方 MCP：读写云文档、多维表格、日历与消息。",
    id: "lark",
    initials: "LK",
    name: "飞书 / Lark",
    requires: [
      { key: "APP_ID", label: "应用 App ID" },
      { key: "APP_SECRET", label: "应用 App Secret" },
    ],
    tint: "#00d6b9",
  },
  {
    args: ["-y", "dingtalk-mcp"],
    categories: ["team"],
    command: "npx",
    description: "钉钉消息与通讯录（社区实现，非官方）。",
    id: "dingtalk",
    initials: "DT",
    name: "钉钉",
    requires: [
      { key: "DINGTALK_APP_KEY", label: "AppKey" },
      { key: "DINGTALK_APP_SECRET", label: "AppSecret" },
    ],
    tint: "#3296fa",
  },
  {
    args: ["-y", "@alipay/mcp-server-alipay"],
    categories: ["finance"],
    command: "npx",
    description: "支付宝官方 MCP：创建订单、查询与退款。",
    id: "alipay",
    initials: "AL",
    name: "支付宝",
    requires: [
      { key: "AP_APP_ID", label: "应用 App ID" },
      { key: "AP_APP_KEY", label: "应用私钥" },
    ],
    tint: "#1677ff",
  },
  {
    args: ["-y", "@sentry/mcp-server"],
    categories: ["dev"],
    command: "npx",
    description: "Sentry 官方 MCP：查异常、事件与告警。",
    id: "sentry",
    initials: "SE",
    name: "Sentry",
    requires: [{ key: "SENTRY_ACCESS_TOKEN", label: "Access Token" }],
    tint: "#362d59",
  },
  {
    args: ["-y", "@variflight-ai/variflight-mcp"],
    categories: ["web"],
    command: "npx",
    description: "飞常准官方 MCP：航班动态、准点率与天气。",
    id: "variflight",
    initials: "VF",
    name: "飞常准 航班",
    requires: [{ key: "VARIFLIGHT_API_KEY", label: "API Key" }],
    tint: "#ff6a00",
  },
  {
    args: ["-y", "12306-mcp"],
    categories: ["web"],
    command: "npx",
    description: "12306 车次、余票与中转查询（社区实现）。",
    id: "railway-12306",
    initials: "12",
    name: "12306 火车票",
    tint: "#2b6cb0",
  },
  {
    args: ["-y", "@amap/amap-maps-mcp-server"],
    categories: ["web"],
    command: "npx",
    description: "地理编码、路径规划、周边搜索，高德官方 MCP 服务。",
    id: "amap",
    initials: "AM",
    name: "高德地图",
    requires: [{ key: "AMAP_MAPS_API_KEY", label: "高德 API Key" }],
    tint: "#0091ff",
  },
  {
    args: ["-y", "@tushare/mcp"],
    categories: ["finance"],
    command: "npx",
    description: "A 股、基金、宏观数据查询，Tushare 官方 MCP 服务。",
    id: "tushare",
    initials: "TS",
    name: "Tushare 金融数据",
    requires: [{ key: "TUSHARE_TOKEN", label: "Tushare Token" }],
    tint: "#c0392b",
  },
];

export function catalogFor(category: ConnectorCategory, query: string) {
  const phrase = query.trim().toLowerCase();
  return CONNECTOR_CATALOG.filter((entry) => {
    if (!entry.categories.includes(category)) return false;
    if (!phrase) return true;
    return (
      entry.name.toLowerCase().includes(phrase) ||
      entry.description.toLowerCase().includes(phrase) ||
      entry.id.includes(phrase)
    );
  });
}
