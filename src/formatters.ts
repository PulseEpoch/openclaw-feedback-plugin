/**
 * Formatting helpers for feedback notifications.
 *
 * Extracts human-readable descriptions from tool call params
 * and produces localized text.
 */

import type { FeedbackLocale } from "./config.js";

/** Extract a short, useful description from a tool's name and params. */
export function describeToolCall(
  toolName: string,
  params?: Record<string, unknown>,
  locale: FeedbackLocale = "zh",
): string {
  const p = params ?? {};
  const zh = locale === "zh";

  switch (toolName) {
    case "read":
    case "read_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? (zh ? `读取 ${fp}` : `Read ${fp}`) : (zh ? "读取文件" : "Read file");
    }
    case "edit":
    case "edit_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? (zh ? `编辑 ${fp}` : `Edit ${fp}`) : (zh ? "编辑文件" : "Edit file");
    }
    case "write":
    case "write_file": {
      const fp = shortPath(getString(p, "file_path"));
      return fp ? (zh ? `写入 ${fp}` : `Write ${fp}`) : (zh ? "写入文件" : "Write file");
    }
    case "exec":
    case "shell": {
      const cmd = truncate(getString(p, "command"), 60);
      return cmd ? (zh ? `执行 \`${cmd}\`` : `Run \`${cmd}\``) : (zh ? "执行命令" : "Run command");
    }
    case "grep":
    case "search": {
      const pat = getString(p, "pattern") ?? getString(p, "query");
      const dir = shortPath(getString(p, "path"));
      if (pat && dir) return zh ? `搜索 "${pat}" in ${dir}` : `Search "${pat}" in ${dir}`;
      if (pat) return zh ? `搜索 "${pat}"` : `Search "${pat}"`;
      return zh ? "搜索代码" : "Search code";
    }
    case "find_file_by_name":
    case "glob": {
      const pat = getString(p, "pattern") ?? getString(p, "glob");
      return pat ? (zh ? `查找 ${pat}` : `Find ${pat}`) : (zh ? "查找文件" : "Find files");
    }
    case "notebook_read": {
      const fp = shortPath(getString(p, "notebook_path"));
      return fp ? (zh ? `读取 ${fp}` : `Read ${fp}`) : (zh ? "读取 notebook" : "Read notebook");
    }
    case "notebook_edit": {
      const fp = shortPath(getString(p, "notebook_path"));
      return fp ? (zh ? `编辑 ${fp}` : `Edit ${fp}`) : (zh ? "编辑 notebook" : "Edit notebook");
    }
    case "run_subagent": {
      const title = getString(p, "title");
      return title ? (zh ? `子任务: ${truncate(title, 40)}` : `Subtask: ${truncate(title, 40)}`) : (zh ? "启动子任务" : "Run subtask");
    }
    case "webfetch":
    case "web_fetch": {
      const url = getString(p, "url");
      if (url) {
        try { return zh ? `访问 ${new URL(url).hostname}` : `Fetch ${new URL(url).hostname}`; } catch { /* ignore */ }
      }
      return zh ? "访问网页" : "Fetch web";
    }
    default:
      return toolName;
  }
}

// ── helpers ─────────────────────────────────────────────────

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Shorten an absolute path to the last 2-3 components. */
function shortPath(fp: string | undefined): string | undefined {
  if (!fp) return undefined;
  const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length <= max ? s : s.slice(0, max) + "...";
}
