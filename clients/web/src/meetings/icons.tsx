import {
  AndroidIcon, BoardIcon as BoardIcon_, CallIcon, ChatIcon as ProChat, ClockIcon as ProClock, ClosedCaptionsIcon, ArrowExportIcon, HeadphonesIcon as ProHeadphones, HeadphonesOffIcon, MicrophoneIcon, MicrophoneOffIcon, RecordIcon, ShareIcon as ProShare, SoundwaveIcon, TuneIcon, VideoIcon as ProVideo, LaptopIcon, FullScreenMaximizeIcon, FullScreenMinimizeIcon,
  GridIcon as ProGrid, PersonIcon, PinIcon as ProPin, PinOffIcon as ProPinOff, PictureInPictureEnterIcon,
} from '@proicons/react';
import { proIcon } from '../components/proicon';

/* Icons for the call bar: ProIcons, drawn like the rest of the app's icons (shell/icons.tsx). */

const Mic = proIcon(MicrophoneIcon);
const MicOff = proIcon(MicrophoneOffIcon);
const Phones = proIcon(ProHeadphones);
const PhonesOff = proIcon(HeadphonesOffIcon);

export const MicIcon = ({ off = false }: { off?: boolean }) => (off ? <MicOff /> : <Mic />);
export const HeadphonesIcon = ({ off = false }: { off?: boolean }) => (off ? <PhonesOff /> : <Phones />);
export const PhoneIcon = proIcon(CallIcon);
export const LeaveIcon = proIcon(ArrowExportIcon);
export const ChatIcon = proIcon(ProChat);
export const CaptionsIcon = proIcon(ClosedCaptionsIcon);
export const SlidersIcon = proIcon(TuneIcon);
export const WaveIcon = proIcon(SoundwaveIcon);
/** The small headset at the start of a call's event line (P34-02). */
export const EventHeadphonesIcon = proIcon(ProHeadphones, 14);

/* Bundle C: the note-taker (a bot), recording, sharing, the board an action item goes to, and a time in the transcript. */
export const BotIcon = proIcon(AndroidIcon);
export const RecordDotIcon = proIcon(RecordIcon);
export const ShareIcon = proIcon(ProShare);
export const BoardIcon = proIcon(BoardIcon_);
export const ClockIcon = proIcon(ProClock);

/* P35-08: the camera, the shared screen, and the stage's full-size switch. */
export const CameraIcon = proIcon(ProVideo);
export const ScreenIcon = proIcon(LaptopIcon);
export const MaximizeIcon = proIcon(FullScreenMaximizeIcon);
export const MinimizeIcon = proIcon(FullScreenMinimizeIcon);

/* P17-01: the stage's layouts (Grid, Speaker), pinning a tile, and the floating picture-in-picture window. */
export const GridIcon = proIcon(ProGrid);
export const SpeakerIcon = proIcon(PersonIcon);
export const PinIcon = proIcon(ProPin, 14);
export const PinOffIcon = proIcon(ProPinOff, 14);
export const PipIcon = proIcon(PictureInPictureEnterIcon);
