import { Spinner, tokens } from '@fluentui/react-components';
import {
  ClockFilled,
  CloudOffFilled,
  ErrorCircleFilled,
  EyeFilled,
  FolderAddFilled,
  PauseCircleFilled,
  PersonLockFilled,
  ShieldCheckmarkFilled,
} from '@fluentui/react-icons';
import type { EngineStatus } from '../lib/types';
import { ago } from '../lib/format';

export type Tone = 'good' | 'busy' | 'wait' | 'bad' | 'neutral';

export interface PhaseInfo {
  title: string;
  short: string;
  tone: Tone;
}

/** Plain-language status for the current engine phase. */
export function phaseInfo(s: EngineStatus): PhaseInfo {
  const last = s.lastSyncAt ? `Last backup ${ago(s.lastSyncAt)}` : 'No backup yet';
  switch (s.phase) {
    case 'idle':
      return { title: 'Protected', short: last, tone: 'good' };
    case 'scanning':
      return { title: 'Checking for changes', short: 'This only takes a moment', tone: 'busy' };
    case 'uploading':
      return { title: 'Backing up', short: s.progress?.stage ?? 'Uploading changes', tone: 'busy' };
    case 'fullBackup':
      return { title: 'Complete backup running', short: s.progress?.stage ?? 'Compressing', tone: 'busy' };
    case 'restoring':
      return { title: 'Restoring files', short: s.progress?.stage ?? 'Working', tone: 'busy' };
    case 'waitingTally':
      return { title: 'Waiting for Tally', short: s.message || 'Backs up after Tally closes', tone: 'wait' };
    case 'waitingQuiet':
      return { title: 'Changes detected', short: 'Backing up when files settle', tone: 'wait' };
    case 'paused':
      return { title: 'Paused', short: 'Automatic backups are off', tone: 'wait' };
    case 'offline':
      return { title: "Can't reach the server", short: 'Will retry automatically', tone: 'bad' };
    case 'error':
      return { title: 'Needs attention', short: s.message || 'Backup failed', tone: 'bad' };
    case 'notConfigured':
      return { title: 'Choose a folder', short: 'Nothing is being backed up yet', tone: 'neutral' };
    case 'readOnly':
      return { title: 'Restore access', short: 'You can browse and restore files', tone: 'neutral' };
    case 'signedOut':
      return { title: 'Signed out', short: 'Sign in to continue', tone: 'neutral' };
    default:
      return { title: 'Starting', short: 'Getting ready', tone: 'neutral' };
  }
}

export const toneColor: Record<Tone, string> = {
  good: tokens.colorStatusSuccessForeground1,
  busy: tokens.colorBrandForeground1,
  wait: tokens.colorStatusWarningForeground1,
  bad: tokens.colorStatusDangerForeground1,
  neutral: tokens.colorNeutralForeground3,
};

export const toneBackground: Record<Tone, string> = {
  good: tokens.colorStatusSuccessBackground1,
  busy: tokens.colorBrandBackground2,
  wait: tokens.colorStatusWarningBackground1,
  bad: tokens.colorStatusDangerBackground1,
  neutral: tokens.colorNeutralBackground3,
};

export function StatusGlyph({ status, size = 20 }: { status: EngineStatus; size?: 20 | 28 }) {
  const tone = phaseInfo(status).tone;
  if (tone === 'busy') return <Spinner size={size === 28 ? 'small' : 'extra-tiny'} aria-hidden style={{ flexShrink: 0 }} />;
  const Icon = (() => {
    switch (status.phase) {
      case 'idle':
        return ShieldCheckmarkFilled;
      case 'paused':
        return PauseCircleFilled;
      case 'offline':
        return CloudOffFilled;
      case 'error':
        return ErrorCircleFilled;
      case 'notConfigured':
        return FolderAddFilled;
      case 'readOnly':
        return EyeFilled;
      case 'signedOut':
        return PersonLockFilled;
      default:
        return ClockFilled;
    }
  })();
  return (
    <span style={{ color: toneColor[tone], flexShrink: 0, display: 'flex' }} aria-hidden>
      <Icon fontSize={size} />
    </span>
  );
}
