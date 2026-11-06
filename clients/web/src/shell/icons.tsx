import {
  ArrowDownIcon as ProArrowDown, ArrowMaximizeIcon, ArrowMinimizeIcon, ArrowReplyIcon, ArrowUpIcon as ProArrowUp, AttachIcon, BellIcon as ProBell,
  BellOffIcon as ProBellOff, BoardIcon, BookmarkIcon as ProBookmark, BuildingMultipleIcon, CancelIcon, CheckmarkCircleIcon, ChevronDownIcon,
  ChevronLeftIcon, ChevronUpIcon as ProChevronUp, ClockIcon as ProClock, CommentIcon, CommentMultipleIcon, EmojiIcon, FileMultipleIcon, FolderIcon as ProFolder,
  LinkIcon, LockIcon as ProLock, MenuIcon as ProMenu, MoonIcon as ProMoon, MoreIcon as ProMore, SearchIcon as ProSearch, SendIcon as ProSend, SettingsIcon,
  StarIcon as ProStar, ArrowSyncIcon, TuneIcon, CheckmarkIcon, AddIcon as ProAdd, SubtractIcon as ProSubtract, PencilIcon as ProPencil, MailIcon as ProMail, HashIcon as ProHash, MentionIcon as ProMention,
  WindowMultipleIcon, MailOpenIcon, BookmarkAddIcon, SparkleIcon, AndroidIcon, ArrowLeftIcon, ArrowRightIcon, DeleteIcon, ArrowLeftRightIcon,
  MicrophoneIcon, PauseIcon as PauseIcon_, PlayIcon as PlayIcon_, SquareIcon,
} from '@proicons/react';
import { BeakerIcon, ChatQuestionIcon, CodeIcon, ColorPaletteIcon, MegaphoneIcon } from '@proicons/react';
import { CalendarIcon, ClipboardIcon, PersonMultipleIcon, VideoClipIcon } from '@proicons/react';
import { ArrowDownloadIcon, BrainIcon, ComputerIcon, DatabaseIcon, GlobeIcon, HomeIcon, KeyIcon, LayersIcon, LockOpenIcon, PersonIcon, PulseIcon, RocketIcon, ShieldCheckmarkIcon, ShieldIcon, TaskListIcon } from '@proicons/react';
import { EyeIcon, EyeOffIcon } from '@proicons/react';
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
export const BotBadgeIcon = proIcon(SparkleIcon, 9, 2.4);

/*
 * The animated mark of "a bot is working on this card" (PLAN P6-13). ProIcons 4.13.7 has no bot or robot icon; AndroidIcon is the stand-in
 * until the owner picks one (AndroidIcon, SparkleIcon or BrainIcon). Changing the mark is a one-line change here.
 */
export const BotWorkingIcon = proIcon(AndroidIcon, 16);
/** The board's column controls. */
export const ColumnLeftIcon = proIcon(ArrowLeftIcon, 14);
export const ColumnRightIcon = proIcon(ArrowRightIcon, 14);
export const ColumnDeleteIcon = proIcon(DeleteIcon, 14);
export const ColumnGripIcon = proIcon(ArrowLeftRightIcon, 14);

/* Voice messages (P14-17): the recorder in the composer. The stop square is drawn filled with `<StopIcon filled />`. */
export const MicIcon = proIcon(MicrophoneIcon, 16);
export const StopIcon = proIcon(SquareIcon, 14);
export const PlayIcon = proIcon(PlayIcon_, 14);
export const PauseIcon = proIcon(PauseIcon_, 14);
export const TrashIcon = proIcon(DeleteIcon, 15);

// the "Add a bot" example cards: one icon for each team template
export const TemplateEngineeringIcon = proIcon(CodeIcon, 18);
export const TemplateSupportIcon = proIcon(ChatQuestionIcon, 18);
export const TemplateMarketingIcon = proIcon(MegaphoneIcon, 18);
export const TemplateDesignIcon = proIcon(ColorPaletteIcon, 18);
export const TemplateResearchIcon = proIcon(BeakerIcon, 18);

// the recipe gallery cards: one icon for each recipe category
export const RecipeRequestsIcon = proIcon(ClipboardIcon, 18);
export const RecipeRhythmIcon = proIcon(CalendarIcon, 18);
export const RecipeCustomersIcon = proIcon(ChatQuestionIcon, 18);
export const RecipeEngineeringIcon = proIcon(CodeIcon, 18);
export const RecipePeopleIcon = proIcon(PersonMultipleIcon, 18);
export const RecipeContentIcon = proIcon(VideoClipIcon, 18);

// the settings navigation: one icon for each page
export const SettingsGeneralIcon = proIcon(HomeIcon, 16);
export const SettingsMembersIcon = proIcon(PersonMultipleIcon, 16);
export const SettingsRolesIcon = proIcon(KeyIcon, 16);
export const SettingsSignInIcon = proIcon(LockOpenIcon, 16);
export const SettingsLlmIcon = proIcon(SparkleIcon, 16);
export const SettingsRunnersIcon = proIcon(ComputerIcon, 16);
export const SettingsMemoryIcon = proIcon(BrainIcon, 16);
export const SettingsDataIcon = proIcon(ShieldCheckmarkIcon, 16);
export const SettingsDomainIcon = proIcon(GlobeIcon, 16);
export const SettingsAuditIcon = proIcon(TaskListIcon, 16);
export const SettingsSetupIcon = proIcon(RocketIcon, 16);
export const SettingsHealthIcon = proIcon(PulseIcon, 16);
export const SettingsUsageIcon = proIcon(DatabaseIcon, 16);
export const SettingsImportIcon = proIcon(ArrowDownloadIcon, 16);
export const SettingsTeamsIcon = proIcon(BuildingMultipleIcon, 16);
export const SettingsTemplateIcon = proIcon(LayersIcon, 16);
export const SettingsProfileIcon = proIcon(PersonIcon, 16);
export const SettingsSecurityIcon = proIcon(ShieldIcon, 16);

// the Show password button: the eye is open while the password is hidden, crossed out while it is shown
export const ShowPasswordIcon = proIcon(EyeIcon, 18);
export const HidePasswordIcon = proIcon(EyeOffIcon, 18);
