import { ArrowDownloadIcon, ArrowMoveIcon, ArrowUpIcon, ArrowDownIcon, BuildingMultipleIcon, BulletListIcon, FolderAddIcon, GridIcon, PencilIcon, PersonIcon as ProPerson, ShareIcon, ArrowUploadIcon, InfoIcon } from '@proicons/react';
import { proIcon } from '../../components/proicon';

/* Icons of the Files screen: ProIcons, drawn like the rest of the app's icons (shell/icons.tsx). */

export const PersonIcon = proIcon(ProPerson, 14);
export const TeamIcon = proIcon(BuildingMultipleIcon, 14);
export const ListViewIcon = proIcon(BulletListIcon, 16);
export const GridViewIcon = proIcon(GridIcon, 16);
export const DownloadIcon = proIcon(ArrowDownloadIcon, 14);
export const RenameIcon = proIcon(PencilIcon, 14);
export const SendToTeamIcon = proIcon(ShareIcon, 14);
export const MoveIcon = proIcon(ArrowMoveIcon, 14);
export const UploadIcon = proIcon(ArrowUploadIcon, 16);
export const NewFolderIcon = proIcon(FolderAddIcon, 14);
export const SortUpIcon = proIcon(ArrowUpIcon, 10, 2.4);
export const SortDownIcon = proIcon(ArrowDownIcon, 10, 2.4);
export const InfoMarkIcon = proIcon(InfoIcon, 14);
