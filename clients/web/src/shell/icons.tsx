import {
  ArrowDownIcon as ProArrowDown, ArrowMaximizeIcon, ArrowMinimizeIcon, ArrowReplyIcon, ArrowUpIcon as ProArrowUp, AttachIcon, BellIcon as ProBell,
  BellOffIcon as ProBellOff, BoardIcon, BookmarkIcon as ProBookmark, BuildingMultipleIcon, CancelIcon, CheckmarkCircleIcon, ChevronDownIcon,
  ChevronLeftIcon, ChevronUpIcon as ProChevronUp, ClockIcon as ProClock, CommentIcon, CommentMultipleIcon, EmojiIcon, FileMultipleIcon, FolderIcon as ProFolder,
  LinkIcon, LockIcon as ProLock, MenuIcon as ProMenu, MoonIcon as ProMoon, MoreIcon as ProMore, SearchIcon as ProSearch, SendIcon as ProSend, SettingsIcon,
  StarIcon as ProStar, ArrowSyncIcon, TuneIcon, CheckmarkIcon, AddIcon as ProAdd, SubtractIcon as ProSubtract, PencilIcon as ProPencil, MailIcon as ProMail, HashIcon as ProHash, MentionIcon as ProMention,
  WindowMultipleIcon, MailOpenIcon, BookmarkAddIcon,
} from '@proicons/react';
import { proIcon } from '../components/proicon';

/* The shell's icons are ProIcons (see components/proicon.tsx); the names below are what the screens import. */

export const FilesIcon = proIcon(FileMultipleIcon);
export const FolderIcon = proIcon(ProFolder, 14);
export const BoardsIcon = proIcon(BoardIcon);
export const OrgIcon = proIcon(BuildingMultipleIcon);
export const ScheduledJobsIcon = proIcon(ArrowSyncIcon);
export const ThreadsIcon = proIcon(CommentMultipleIcon);
export const ApprovalsIcon = proIcon(CheckmarkCircleIcon);
export const DmIcon = proIcon(CommentIcon);

const Chevron = proIcon(ChevronDownIcon, 10, 2.4);
export const CaretIcon = ({ open = false }: { open?: boolean }) => (
  <span aria-hidden="true" style={{ display: 'inline-flex', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.12s' }}>
    <Chevron />
  </span>
);
export const SearchIcon = proIcon(ProSearch, 14);
export const MenuIcon = proIcon(ProMenu, 18);
export const CloseIcon = proIcon(CancelIcon, 14);
export const ExpandIcon = proIcon(ArrowMaximizeIcon);
export const RestoreIcon = proIcon(ArrowMinimizeIcon);
export const BackIcon = proIcon(ChevronLeftIcon, 14);
export const GearIcon = proIcon(SettingsIcon);
export const LockIcon = proIcon(ProLock, 12);

export const NAV_ICONS = { files: FilesIcon, boards: BoardsIcon, org: OrgIcon, jobs: ScheduledJobsIcon, threads: ThreadsIcon, approvals: ApprovalsIcon, dm: DmIcon } as const;

export const ReplyIcon = proIcon(ArrowReplyIcon, 14);
export const SmileIcon = proIcon(EmojiIcon, 14);
export const MoreIcon = proIcon(ProMore, 14);
export const ClipIcon = proIcon(AttachIcon, 15);
export const SendIcon = proIcon(ProSend, 15);
/** A small caret pointing up: the "more ways to send" button beside Send, whose menu opens upward. */
export const ChevronUpIcon = proIcon(ProChevronUp, 14);
/** A clock face: scheduled messages. */
export const ClockIcon = proIcon(ProClock, 14);
export const ArrowDownIcon = proIcon(ProArrowDown, 14);
export const ArrowUpIcon = proIcon(ProArrowUp, 14);
/** Two chain links: an address that joins two programs (the channel's incoming webhooks). */
export const HookIcon = proIcon(LinkIcon);
/** The bell with a stroke through it: a channel set to "Nothing". */
export const BellOffIcon = proIcon(ProBellOff);
export const BookmarkIcon = proIcon(ProBookmark);
/** A crescent moon: Do not disturb is on. */
export const MoonIcon = proIcon(ProMoon, 14);
export const BellIcon = proIcon(ProBell);

const Star = proIcon(ProStar);
/** A star: outline for "not starred", filled for "starred". */
export const StarIcon = ({ filled = false }: { filled?: boolean }) => <Star filled={filled} />;

/** Two sliders: the options of the channel list. */
export const OptionsIcon = proIcon(TuneIcon);

export const CheckIcon = proIcon(CheckmarkIcon, 14);
export const PencilIcon = proIcon(ProPencil, 14);
export const MailIcon = proIcon(ProMail, 14);
export const HashIcon = proIcon(ProHash, 14);
export const MentionIcon = proIcon(ProMention, 14);
/** Two windows: open something in a window of its own. */
export const NewWindowIcon = proIcon(WindowMultipleIcon, 14);
/** An opened envelope: mark as read. */
export const MarkReadIcon = proIcon(MailOpenIcon, 14);
/** A bookmark with a plus: save a message for later. */
export const SaveForLaterIcon = proIcon(BookmarkAddIcon, 14);
/** Two chain links: copy the address of something. */
export const CopyLinkIcon = proIcon(LinkIcon, 14);
export const AddIcon = proIcon(ProAdd, 14);
export const SubtractIcon = proIcon(ProSubtract, 14);
