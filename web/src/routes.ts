import {
  LayoutDashboard,
  Heart,
  Plug,
  Users,
  Activity,
  MessagesSquare,
  Search,
  Brain,
  Database,
  Bot,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
  /** Optional: only show when an endpoint returns true (e.g. enabled integrations). */
  visible?: () => boolean | Promise<boolean>;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Overview", Icon: LayoutDashboard },
  { to: "/health", label: "Health", Icon: Heart },
  { to: "/providers", label: "Providers", Icon: Users },
  { to: "/traffic", label: "Traffic", Icon: Activity },
  { to: "/conversations", label: "Conversations", Icon: MessagesSquare },
  { to: "/inspector", label: "Inspector", Icon: Search },
  { to: "/thinking", label: "Thinking", Icon: Brain },
  { to: "/memory", label: "Memory", Icon: Database },
  { to: "/mcp", label: "MCP & Skills", Icon: Plug },
  { to: "/august", label: "August", Icon: Bot },
] as const;

export const SECTION_PATH = (to: string) => to;
