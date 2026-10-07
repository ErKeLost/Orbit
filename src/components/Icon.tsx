import type { IconComponent } from "../shared/ui/icons";
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Copy,
  CornerDownRight,
  CursorMagicSelection,
  DashboardSquare,
  ExternalLink,
  File,
  FileScript,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompare,
  GitMerge,
  Globe,
  ImagePlus,
  Inbox,
  Keyboard,
  ListBullet,
  ListFilter,
  MessageMultiple,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Palette,
  PanelLeft,
  PenLine,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Share,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePlus,
  StickyNote,
  Terminal,
  Trash2 as Trash,
  Ungroup,
  Wrench,
  X,
  Zap,
} from "../shared/ui/icons";
import { Icon as Iconify, addCollection } from "@iconify/react";
import fluentColor from "@iconify-json/fluent-color/icons.json";
import { FileTypeIcon } from "../features/shell/FileTypeIcon";

// Bundled locally so rendering never hits the network.
addCollection(fluentColor as never);

/**
 * Orbit's components still ask for icons by their old Phosphor names. Every
 * name resolves to MonoCode's Hugeicons set, so nothing renders from the
 * previous icon families anymore.
 */
const GLYPHS: Record<string, IconComponent> = {
  "arrow-bend-up-right": CornerDownRight,
  "arrow-down": ChevronDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ChevronRight,
  "arrow-up": ArrowUp,
  "arrow-up-right": ExternalLink,
  "arrows-clockwise": RefreshCw,
  "book-open": File,
  "bookmark-simple": StickyNote,
  "caret-down": ChevronDown,
  "caret-left": ChevronLeft,
  "caret-right": ChevronRight,
  "caret-up": ChevronUp,
  "caret-up-down": ChevronsUpDown,
  "chart-bar": DashboardSquare,
  "chat-circle": MessageSquare,
  "chat-circle-text": MessageSquare,
  "chat-teardrop-text": MessageSquare,
  chats: MessageMultiple,
  check: Check,
  code: FileScript,
  command: Keyboard,
  copy: Copy,
  cpu: CursorMagicSelection,
  database: Bot,
  desktop: DashboardSquare,
  "device-mobile": Share,
  "dots-three": MoreHorizontal,
  "dots-three-bold": MoreHorizontal,
  download: ArrowDownCircle,
  export: ArrowDownCircle,
  "file-magnifying-glass": Search,
  "folder-open": FolderOpen,
  "folder-simple": Folder,
  funnel: ListFilter,
  "gear-six": Settings,
  "git-commit": GitMerge,
  "git-fork": GitBranch,
  globe: Globe,
  "image-square": ImagePlus,
  keyboard: Keyboard,
  list: ListBullet,
  "magnifying-glass": Search,
  message: MessageSquare,
  "note-pencil": MessageSquarePlus,
  package: Inbox,
  palette: Palette,
  "pencil-simple": Pencil,
  "play-circle": Play,
  plus: Plus,
  "plus-circle": SquarePlus,
  "puzzle-piece": Sparkles,
  "share-network": Share,
  "shield-check": Shield,
  "sidebar-simple": PanelLeft,
  sparkle: Sparkles,
  stack: FolderTree,
  "stop-fill": Square,
  "terminal-window": Terminal,
  "text-align-left": ListBullet,
  "theme-color": Palette,
  translate: Globe,
  trash: Trash,
  "tree-structure": Ungroup,
  "warning-circle": AlertCircle,
  wrench: Wrench,
  x: X,
  "youtube-logo-fill": Play,
  "git-compare": GitCompare,
  "pen-line": PenLine,
  "sliders-horizontal": SlidersHorizontal,
  zap: Zap,
};

export function Icon({ name, className = "size-4" }: { name: string; className?: string }) {
  const key = name.replace(/^ph:/, "");
  // Prefixed names are彩色 collections (fluent-color for agent kinds, devicon
  // for links); the monochrome chrome set below is Hugeicons.
  if (key.includes(":")) return <Iconify icon={key} className={className} aria-hidden />;
  const Glyph = GLYPHS[key];
  if (Glyph) return <Glyph className={className} strokeWidth={1.75} aria-hidden />;
  // Old colored file-type names (vscode-icons:/catppuccin:) map to Material icons.
  const fileType = /^(?:vscode-icons:file-type-|catppuccin:)(.+)$/.exec(key)?.[1];
  if (fileType) return <FileTypeIcon name={`file.${fileType.replace(/2$/, "")}`} isDir={false} size={16} />;
  return <Sparkles className={className} strokeWidth={1.75} aria-hidden />;
}

export function FileIcon({ path, className: _className }: { path: string; className?: string }) {
  const name = path.trim().split(/[\\/]/).at(-1) ?? path;
  return <FileTypeIcon name={name} isDir={false} size={14} />;
}
