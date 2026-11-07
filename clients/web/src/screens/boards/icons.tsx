import { ArrowRightIcon, CalendarIcon, ChatQuestionIcon, ClipboardIcon, PulseIcon, RocketIcon, TaskListIcon } from '@proicons/react';
import { proIcon } from '../../components/proicon';

/* Pictures of the Boards, Jobs and Org chart screens: ProIcons drawn like the rest of the app's icons (shell/icons.tsx). */

/** The three board templates of an empty Boards page. */
export const TemplateDeliveryIcon = proIcon(RocketIcon, 28, 1.5);
export const TemplateSupportQueueIcon = proIcon(ChatQuestionIcon, 28, 1.5);
export const TemplateContentIcon = proIcon(CalendarIcon, 28, 1.5);

/** The three kinds of job on an empty Jobs page. */
export const JobHeartbeatIcon = proIcon(PulseIcon, 28, 1.5);
export const JobRoutineIcon = proIcon(ClipboardIcon, 28, 1.5);
export const JobTaskIcon = proIcon(TaskListIcon, 28, 1.5);

/** The arrow from a bot to a bot it may hand work to, on the org chart. */
export const HandToIcon = proIcon(ArrowRightIcon, 12, 2);
