import {
  CallIcon, ChatIcon as ProChat, ClosedCaptionsIcon, ArrowExportIcon, HeadphonesIcon as ProHeadphones, HeadphonesOffIcon, MicrophoneIcon, MicrophoneOffIcon, SoundwaveIcon, TuneIcon,
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
