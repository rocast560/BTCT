import { useRef, useState } from 'react';
import { X, Upload, Trash2 } from 'lucide-react';
import { useAuthStore, type AuthUser } from '@/auth/auth-store';

const COLOR_PRESETS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  '#22d3ee', '#a855f7', '#84cc16', '#eab308',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Resize an image File to a square PNG data URL via canvas. */
async function fileToAvatarDataUrl(file: File, size = 64): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('invalid image'));
    i.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  // Cover-style crop
  const ratio = Math.max(size / img.width, size / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  ctx.drawImage(img, x, y, w, h);
  return canvas.toDataURL('image/png');
}

export function ProfileEditor({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user) as AuthUser;
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [color, setColor] = useState(user.color);
  const [avatar, setAvatar] = useState<string | null>(user.avatar);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dirty = color !== user.color || avatar !== user.avatar;

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('please choose an image file');
      return;
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setAvatar(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read image');
    }
  };

  const handleSave = async () => {
    if (!HEX_RE.test(color)) {
      setError('color must be a #RRGGBB hex value');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProfile({ color, avatar });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-4 py-3">
          <span className="text-[11px] font-bold uppercase tracking-widest">Edit Profile</span>
          <button onClick={onClose} className="p-1 hover:bg-[hsl(var(--accent))]" title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {/* Username (read-only) */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Username
            </label>
            <div className="border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1.5 text-xs text-[hsl(var(--muted-foreground))]">
              {user.username}
            </div>
          </div>

          {/* Avatar */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Avatar
            </label>
            <div className="flex items-center gap-3">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[hsl(var(--border))]"
                style={{ backgroundColor: color }}
              >
                {avatar ? (
                  <img src={avatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-base font-semibold text-white">
                    {user.username.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center gap-1.5 border border-[hsl(var(--border))] px-2 py-1.5 text-[11px] hover:bg-[hsl(var(--accent))]"
                >
                  <Upload size={11} />
                  <span>{avatar ? 'Replace image' : 'Upload image'}</span>
                </button>
                {avatar && (
                  <button
                    type="button"
                    onClick={() => setAvatar(null)}
                    className="flex items-center justify-center gap-1.5 border border-[hsl(var(--border))] px-2 py-1.5 text-[11px] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
                  >
                    <Trash2 size={11} />
                    <span>Remove</span>
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="mt-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
              Images are scaled to 64×64 PNG. Shows next to your live cursor.
            </p>
          </div>

          {/* Color */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Color
            </label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c}
                  className={`h-6 w-6 rounded-full border transition ${color.toLowerCase() === c.toLowerCase() ? 'border-white ring-2 ring-white/40' : 'border-[hsl(var(--border))] hover:border-white/60'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(color) ? color : '#3b82f6'}
                onChange={(e) => setColor(e.target.value)}
                className="h-7 w-9 cursor-pointer border border-[hsl(var(--input))] bg-[hsl(var(--background))]"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#rrggbb"
                className="flex-1 border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2 py-1 font-mono text-xs outline-none"
              />
            </div>
          </div>

          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[hsl(var(--border))] px-4 py-3">
          <button
            onClick={onClose}
            className="border border-[hsl(var(--border))] px-3 py-1.5 text-xs hover:bg-[hsl(var(--accent))]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="border border-[hsl(var(--primary))] bg-[hsl(var(--primary))] px-3 py-1.5 text-xs text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
