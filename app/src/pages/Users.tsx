import {
  Avatar,
  Badge,
  Body1,
  Button,
  Caption1,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  OverlayDrawer,
  Skeleton,
  SkeletonItem,
  Spinner,
  Subtitle2,
  Tag,
  TagGroup,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  Copy20Regular,
  Delete20Regular,
  Dismiss24Regular,
  Edit20Regular,
  Eye24Regular,
  FolderLink24Regular,
  FolderProhibited24Regular,
  Folder24Regular,
  FolderMultiple24Regular,
  Key20Regular,
  LockOpen20Regular,
  MoreHorizontal20Regular,
  PersonAdd20Regular,
  PersonProhibited20Regular,
  PersonAvailable20Regular,
  SignOut20Regular,
  ArrowSyncCircle24Regular,
  DismissCircle24Regular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { FolderTree } from '../components/FolderTree';
import { ConfirmDialog, EmptyState, OptionCards, Page, PageHeader, Panel, useLoader } from '../components/ui';
import { api, backend, errorMessage } from '../lib/backend';
import { ago, plural } from '../lib/format';
import { buildTree } from '../lib/tree';
import type { Access, FolderInfo, ManagedUser, ScopeMode } from '../lib/types';
import { useApp } from '../state';

const useStyles = makeStyles({
  table: { padding: 0, overflow: 'hidden' },
  headRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.5fr) 120px minmax(0, 1.2fr) 84px 72px',
    gap: '12px',
    padding: '10px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.5fr) 120px minmax(0, 1.2fr) 84px 72px',
    gap: '12px',
    alignItems: 'center',
    padding: '10px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  person: { display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 },
  personText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowActions: { display: 'flex', justifyContent: 'flex-end', gap: '2px' },
  form: { display: 'flex', flexDirection: 'column', gap: '22px', paddingBottom: '12px' },
  section: { display: 'flex', flexDirection: 'column', gap: '10px' },
  pwRow: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
  tags: { flexWrap: 'wrap', gap: '6px' },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px', width: '100%' },
});

const ACCESS_LABEL: Record<string, string> = { read: 'Read only', write: 'Read & write' };

function scopeSummary(u: Pick<ManagedUser, 'role' | 'scopeMode' | 'paths'>) {
  if (u.role === 'superadmin' || u.scopeMode === 'all') return 'Every folder';
  if (u.scopeMode === 'none') return 'No folders';
  const list = u.paths.slice(0, 2).join(', ') + (u.paths.length > 2 ? ` +${u.paths.length - 2}` : '');
  return u.scopeMode === 'include' ? `Only ${list}` : `All except ${list}`;
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

interface Draft {
  id: number | null;
  displayName: string;
  username: string;
  password: string;
  access: Access;
  scopeMode: ScopeMode;
  paths: string[];
  isSuper: boolean;
}

const emptyDraft: Draft = { id: null, displayName: '', username: '', password: '', access: 'read', scopeMode: 'include', paths: [], isSuper: false };

function Editor({
  draft,
  setDraft,
  folders,
  foldersLoading,
  onClose,
  onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  folders: FolderInfo[];
  foldersLoading: boolean;
  onClose: () => void;
  onSaved: (u: ManagedUser) => void;
}) {
  const s = useStyles();
  const { notify } = useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(draft.id === null);
  const [touched, setTouched] = useState(false);
  const roots = useMemo(() => buildTree(folders), [folders]);
  const isNew = draft.id === null;

  const usernameError =
    touched && isNew && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,39}$/.test(draft.username) ? 'Use 2–40 letters, numbers, dots, dashes or underscores.' : undefined;
  const nameError = touched && !draft.displayName.trim() ? 'Enter a name.' : undefined;
  const passwordError = touched && showPassword && (isNew || draft.password) && draft.password.length < 8 ? 'Use at least 8 characters.' : undefined;
  const scopeError =
    touched && (draft.scopeMode === 'include' || draft.scopeMode === 'exclude') && draft.paths.length === 0
      ? draft.scopeMode === 'include'
        ? 'Tick at least one folder to share.'
        : 'Tick at least one folder to keep private.'
      : undefined;

  const save = async () => {
    setTouched(true);
    const invalid =
      !draft.displayName.trim() ||
      (isNew && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,39}$/.test(draft.username)) ||
      (showPassword && (isNew || draft.password) && draft.password.length < 8) ||
      ((draft.scopeMode === 'include' || draft.scopeMode === 'exclude') && draft.paths.length === 0 && !draft.isSuper);
    if (invalid) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { displayName: draft.displayName.trim() };
      if (!draft.isSuper) Object.assign(body, { access: draft.access, scopeMode: draft.scopeMode, paths: draft.paths });
      if (showPassword && draft.password) body.password = draft.password;
      const res = isNew
        ? await api<{ user: ManagedUser }>('POST', '/api/users', { ...body, username: draft.username.trim() })
        : await api<{ user: ManagedUser }>('PATCH', `/api/users/${draft.id}`, body);
      notify('success', isNew ? `${draft.displayName.trim()} can now sign in` : 'Changes saved', isNew ? `Username: ${draft.username.trim()}` : undefined);
      onSaved(res.user);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={onClose} />}>
          {isNew ? 'Add a user' : `Edit ${draft.displayName || draft.username}`}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.form}>
          <section className={s.section}>
            <Field label="Name" required validationMessage={nameError}>
              <Input value={draft.displayName} onChange={(_, d) => setDraft({ ...draft, displayName: d.value })} placeholder="e.g. Priya Sharma" autoFocus={isNew} />
            </Field>
            {isNew ? (
              <Field label="Username" required validationMessage={usernameError} hint="Used to sign in. It can't be changed later.">
                <Input value={draft.username} onChange={(_, d) => setDraft({ ...draft, username: d.value.replace(/\s/g, '') })} placeholder="e.g. priya" spellCheck={false} />
              </Field>
            ) : (
              <Field label="Username">
                <Text className="selectable">{draft.username}</Text>
              </Field>
            )}
            {showPassword ? (
              <Field
                label={isNew ? 'Password' : 'New password'}
                required={isNew}
                validationMessage={passwordError}
                hint="Share it with the user privately. They can change it in Settings."
              >
                <div className={s.pwRow}>
                  <Input
                    style={{ flex: 1 }}
                    value={draft.password}
                    onChange={(_, d) => setDraft({ ...draft, password: d.value })}
                    spellCheck={false}
                    autoComplete="new-password"
                  />
                  <Tooltip content="Create a strong password" relationship="label">
                    <Button icon={<ArrowClockwise20Regular />} onClick={() => setDraft({ ...draft, password: generatePassword() })} />
                  </Tooltip>
                  <Tooltip content="Copy password" relationship="label">
                    <Button
                      icon={<Copy20Regular />}
                      disabled={!draft.password}
                      onClick={() => void navigator.clipboard.writeText(draft.password).then(() => notify('info', 'Password copied'))}
                    />
                  </Tooltip>
                </div>
              </Field>
            ) : (
              <div>
                <Button icon={<Key20Regular />} onClick={() => (setShowPassword(true), setDraft({ ...draft, password: generatePassword() }))}>
                  Reset password
                </Button>
              </div>
            )}
          </section>

          {draft.isSuper ? (
            <MessageBar intent="info">
              <MessageBarBody>The administrator always has full access to every folder.</MessageBarBody>
            </MessageBar>
          ) : (
            <>
              <section className={s.section}>
                <Subtitle2 as="h3">What they can do</Subtitle2>
                <OptionCards
                  label="Access level"
                  value={draft.access}
                  onChange={(v) => setDraft({ ...draft, access: v })}
                  options={[
                    { value: 'read', title: 'Read only', description: 'Browse backups and restore files to their computer', icon: <Eye24Regular /> },
                    { value: 'write', title: 'Read & write', description: 'Also back up files from their own computer', icon: <ArrowSyncCircle24Regular /> },
                  ]}
                />
              </section>

              <section className={s.section}>
                <Subtitle2 as="h3">Which folders they can see</Subtitle2>
                <OptionCards
                  label="Folder access"
                  value={draft.scopeMode}
                  onChange={(v) => setDraft({ ...draft, scopeMode: v })}
                  options={[
                    { value: 'all', title: 'Everything', description: 'All folders, including new ones', icon: <FolderMultiple24Regular /> },
                    { value: 'include', title: 'Only selected folders', description: 'Just the folders you tick', icon: <FolderLink24Regular /> },
                    { value: 'exclude', title: 'All except selected', description: 'Everything apart from the folders you tick', icon: <FolderProhibited24Regular /> },
                    { value: 'none', title: 'Nothing for now', description: 'Can sign in but sees no files', icon: <DismissCircle24Regular /> },
                  ]}
                />
                {draft.scopeMode === 'include' || draft.scopeMode === 'exclude' ? (
                  <Field
                    label={draft.scopeMode === 'include' ? 'Folders to share' : 'Folders to keep private'}
                    validationMessage={scopeError}
                    validationState={scopeError ? 'error' : 'none'}
                  >
                    {foldersLoading ? (
                      <Skeleton aria-label="Loading folders">
                        <SkeletonItem style={{ height: 200 }} />
                      </Skeleton>
                    ) : (
                      <FolderTree
                        roots={roots}
                        selected={draft.paths}
                        onChange={(paths) => setDraft({ ...draft, paths })}
                        label={draft.scopeMode === 'include' ? 'Folders to share' : 'Folders to keep private'}
                        emptyText="No folders have been backed up yet. Choose the backup folder in Backup settings first."
                        maxHeight={300}
                      />
                    )}
                  </Field>
                ) : null}
                {(draft.scopeMode === 'include' || draft.scopeMode === 'exclude') && draft.paths.length ? (
                  <TagGroup
                    className={s.tags}
                    aria-label="Chosen folders"
                    onDismiss={(_, d) => setDraft({ ...draft, paths: draft.paths.filter((p) => p !== d.value) })}
                  >
                    {draft.paths.map((p) => (
                      <Tag key={p} value={p} dismissible dismissIcon={{ 'aria-label': `Remove ${p}` }} icon={<Folder24Regular />} size="small" shape="circular">
                        {p}
                      </Tag>
                    ))}
                  </TagGroup>
                ) : null}
              </section>
            </>
          )}

          {error ? (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          ) : null}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <div className={s.footer}>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button appearance="primary" onClick={save} disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined}>
            {isNew ? 'Add user' : 'Save changes'}
          </Button>
        </div>
      </DrawerFooter>
    </>
  );
}

export default function Users() {
  const s = useStyles();
  const { config, notify } = useApp();
  const users = useLoader(() => api<{ users: ManagedUser[] }>('GET', '/api/users').then((r) => r.users), []);
  const folders = useLoader(async () => {
    const server = await api<{ folders: FolderInfo[] }>('GET', '/api/folders').then((r) => r.folders);
    let local: FolderInfo[] = [];
    if (config.watchedFolder) {
      local = await backend
        .scanFolder(config.watchedFolder, config.policy.exclude)
        .then((r) => r.folders)
        .catch(() => []);
    }
    const map = new Map<string, FolderInfo>();
    for (const f of [...server, ...local]) {
      const cur = map.get(f.path);
      map.set(f.path, cur ? { path: f.path, files: Math.max(cur.files, f.files), bytes: Math.max(cur.bytes, f.bytes) } : f);
    }
    return [...map.values()];
  }, [config.watchedFolder]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'delete' | 'revoke'; user: ManagedUser }>(null);
  const [busy, setBusy] = useState(false);

  const patch = async (u: ManagedUser, body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      await api('PATCH', `/api/users/${u.id}`, body);
      notify('success', message);
      void users.reload();
      setConfirm(null);
    } catch (e) {
      notify('error', 'That did not work', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: ManagedUser) => {
    setBusy(true);
    try {
      await api('DELETE', `/api/users/${u.id}`);
      notify('success', `${u.displayName} was deleted`);
      void users.reload();
      setConfirm(null);
    } catch (e) {
      notify('error', 'Could not delete the user', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const list = users.data ?? [];
  const others = list.filter((u) => u.role !== 'superadmin');

  return (
    <Page>
      <PageHeader
        title="Users & access"
        description="Decide who can sign in, whether they can back up or only restore, and which folders they can see."
        actions={
          <Button appearance="primary" icon={<PersonAdd20Regular />} onClick={() => setDraft({ ...emptyDraft, password: generatePassword() })}>
            Add user
          </Button>
        }
      />

      {users.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{users.error}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={users.reload}>
              Try again
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      <Panel className={s.table} pad={false}>
        <div className={s.headRow} role="row">
          <Caption1>Person</Caption1>
          <Caption1>Can</Caption1>
          <Caption1>Folders</Caption1>
          <Caption1>Status</Caption1>
          <span />
        </div>
        {users.loading && !users.data ? (
          <div style={{ padding: 16 }}>
            <Skeleton aria-label="Loading users">
              <SkeletonItem style={{ height: 40, marginBottom: 8 }} />
              <SkeletonItem style={{ height: 40 }} />
            </Skeleton>
          </div>
        ) : (
          list.map((u) => {
            const isSuper = u.role === 'superadmin';
            return (
              <div key={u.id} className={s.row} role="row">
                <div className={s.person}>
                  <Avatar name={u.displayName} color="colorful" size={32} />
                  <div className={s.personText}>
                    <Text weight="semibold" className={s.ellipsis}>
                      {u.displayName}
                    </Text>
                    <Caption1 className={mergeClasses(s.muted, s.ellipsis)}>
                      <span className="selectable">{u.username}</span> · {u.lastLoginAt ? `signed in ${ago(u.lastLoginAt)}` : 'never signed in'}
                    </Caption1>
                  </div>
                </div>
                <div>
                  <Badge appearance="tint" color={isSuper ? 'brand' : u.access === 'write' ? 'informative' : 'subtle'}>
                    {isSuper ? 'Administrator' : ACCESS_LABEL[u.access]}
                  </Badge>
                </div>
                <Caption1 className={s.ellipsis} title={u.paths.join('\n')}>
                  {scopeSummary(u)}
                </Caption1>
                <div>
                  {u.disabled ? (
                    <Badge appearance="tint" color="danger">
                      Revoked
                    </Badge>
                  ) : u.locked ? (
                    <Badge appearance="tint" color="warning">
                      Locked
                    </Badge>
                  ) : (
                    <Badge appearance="tint" color="success">
                      Active
                    </Badge>
                  )}
                </div>
                <div className={s.rowActions}>
                  <Tooltip content={`Edit ${u.displayName}`} relationship="label">
                    <Button
                      appearance="subtle"
                      icon={<Edit20Regular />}
                      onClick={() =>
                        setDraft({
                          id: u.id,
                          displayName: u.displayName,
                          username: u.username,
                          password: '',
                          access: u.access,
                          scopeMode: u.scopeMode,
                          paths: u.paths,
                          isSuper,
                        })
                      }
                    />
                  </Tooltip>
                  {!isSuper ? (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`More actions for ${u.displayName}`} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          {u.locked ? (
                            <MenuItem icon={<LockOpen20Regular />} onClick={() => patch(u, { unlock: true }, `${u.displayName} can sign in again`)}>
                              Unlock sign-in
                            </MenuItem>
                          ) : null}
                          <MenuItem icon={<SignOut20Regular />} disabled={!u.activeSessions} onClick={() => patch(u, { signOut: true }, `${u.displayName} was signed out everywhere`)}>
                            Sign out everywhere{u.activeSessions ? ` (${u.activeSessions})` : ''}
                          </MenuItem>
                          {u.disabled ? (
                            <MenuItem icon={<PersonAvailable20Regular />} onClick={() => patch(u, { disabled: false }, `${u.displayName}'s access was restored`)}>
                              Restore access
                            </MenuItem>
                          ) : (
                            <MenuItem icon={<PersonProhibited20Regular />} onClick={() => setConfirm({ kind: 'revoke', user: u })}>
                              Revoke access
                            </MenuItem>
                          )}
                          <MenuDivider />
                          <MenuItem icon={<Delete20Regular />} onClick={() => setConfirm({ kind: 'delete', user: u })}>
                            Delete user
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        {users.data && others.length === 0 ? (
          <EmptyState
            icon={<PersonAdd20Regular />}
            title="Only you can sign in"
            body="Add colleagues so they can restore files from the folders you share with them."
            action={
              <Button icon={<PersonAdd20Regular />} onClick={() => setDraft({ ...emptyDraft, password: generatePassword() })}>
                Add the first user
              </Button>
            }
          />
        ) : null}
      </Panel>

      <Body1 className={s.muted}>
        Revoking access signs the person out on every computer immediately. Their backups and history are kept.
      </Body1>

      <OverlayDrawer open={draft !== null} position="end" size="medium" onOpenChange={(_, d) => !d.open && setDraft(null)}>
        {draft ? (
          <Editor
            key={draft.id ?? 'new'}
            draft={draft}
            setDraft={setDraft}
            folders={folders.data ?? []}
            foldersLoading={folders.loading && !folders.data}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              void users.reload();
            }}
          />
        ) : null}
      </OverlayDrawer>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.user.displayName}?` : `Revoke ${confirm?.user.displayName}'s access?`}
        confirmLabel={confirm?.kind === 'delete' ? 'Delete user' : 'Revoke access'}
        danger
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && (confirm.kind === 'delete' ? remove(confirm.user) : patch(confirm.user, { disabled: true }, `${confirm.user.displayName}'s access was revoked`))}
      >
        {confirm?.kind === 'delete'
          ? `${confirm.user.displayName} (${confirm.user.username}) will be signed out and can no longer sign in. Backups they made stay in the history. This can't be undone.`
          : `${confirm?.user.displayName} will be signed out on every computer and can't sign in until you restore access. Their settings are kept.`}
        {confirm ? <Caption1 style={{ display: 'block', marginTop: 8 }}>{plural(confirm.user.activeSessions, 'active session')}</Caption1> : null}
      </ConfirmDialog>
    </Page>
  );
}
