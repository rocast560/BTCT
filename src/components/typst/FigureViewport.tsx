// ─────────────────────────────────────────────────────────────────────────
// The framing surface of the crop window.
//
// A fixed frame drawn to the figure box's real proportions — same rounded
// corners, same border, same placeholder grey — with the image floating
// behind it. Drag to pan, wheel or the zoom control to scale. Whatever falls
// inside the frame is exactly what the figure renders; the rest is dimmed to
// show it will be clipped at the border.
//
// The frame stays put and the image moves, rather than the other way round,
// because the frame *is* the output. Sizing the on-screen frame from the
// same aspect ratio the renderer uses is what makes this WYSIWYG.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CropRect } from '@/types';
import { panCrop, zoomCrop } from '@/lib/crop-math';

/** Padding between the frame and the edge of its container, in px. */
const FRAME_MARGIN = 48;

export function FigureViewport({
  imageUrl,
  crop,
  boxAspect,
  onCropChange,
}: {
  imageUrl: string;
  /** Visible region of the image, in normalized image coordinates. */
  crop: CropRect;
  /** width / height of the figure box — the frame's shape. */
  boxAspect: number;
  onCropChange: (next: CropRect) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });

  // The wheel listener below is bound per frame size, so it reads the crop
  // through a ref rather than rebinding on every pan.
  const cropRef = useRef(crop);
  cropRef.current = crop;

  // Size the frame to fill the available space at the box's aspect ratio.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const availW = Math.max(rect.width - FRAME_MARGIN * 2, 40);
      const availH = Math.max(rect.height - FRAME_MARGIN * 2, 40);
      // Fit the frame inside the available box without distorting it.
      const width = Math.min(availW, availH * boxAspect);
      setFrame({ width, height: width / boxAspect });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [boxAspect]);

  // ── image placement ────────────────────────────────────────────────────
  // The crop says which part of the image the frame shows. Inverting that
  // gives where the image sits relative to the frame: the whole image spans
  // frame.width / crop.w, offset by -crop.x of that span.
  const imageWidth = frame.width / crop.w;
  const imageHeight = frame.height / crop.h;
  const imageLeft = -crop.x * imageWidth;
  const imageTop = -crop.y * imageHeight;

  // ── panning ────────────────────────────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; start: CropRect } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, start: crop };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }, [crop]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || frame.width === 0) return;
    // Screen pixels → normalized image units. Dragging right moves the image
    // right, which means the visible window moves *left* across it.
    const dx = -((e.clientX - drag.x) / frame.width) * drag.start.w;
    const dy = -((e.clientY - drag.y) / frame.height) * drag.start.h;
    onCropChange(panCrop(drag.start, dx, dy));
  }, [frame.width, frame.height, onCropChange]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  // ── wheel zoom ─────────────────────────────────────────────────────────
  // Registered natively rather than via onWheel so it can be non-passive and
  // preventDefault the page scroll.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      // Anchor on the pointer so the point under the cursor stays put.
      const frameLeft = rect.left + (rect.width - frame.width) / 2;
      const frameTop = rect.top + (rect.height - frame.height) / 2;
      const anchorX = frame.width > 0 ? (e.clientX - frameLeft) / frame.width : 0.5;
      const anchorY = frame.height > 0 ? (e.clientY - frameTop) / frame.height : 0.5;
      const factor = Math.exp(e.deltaY * 0.0015);
      onCropChange(zoomCrop(cropRef.current, factor, anchorX, anchorY));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [frame.width, frame.height, onCropChange]);

  return (
    <div
      ref={hostRef}
      className="relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
    >
      {frame.width > 0 && (
        <div
          className="relative cursor-grab active:cursor-grabbing"
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Everything outside the frame: the image continues, dimmed, so
              you can see what you're cutting off. */}
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            aria-hidden
            className="pointer-events-none absolute max-w-none opacity-25"
            style={{
              width: imageWidth,
              height: imageHeight,
              left: imageLeft,
              top: imageTop,
            }}
          />

          {/* The frame itself, clipping the image to exactly what renders. */}
          <div
            className="absolute inset-0 overflow-hidden rounded"
            style={{
              backgroundColor: '#f5f5f5',
              // Matches the helper's `stroke: 1pt + luma(180)`.
              boxShadow: 'inset 0 0 0 1px #b4b4b4, 0 0 0 9999px rgba(0,0,0,0.45)',
            }}
          >
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{
                width: imageWidth,
                height: imageHeight,
                left: imageLeft,
                top: imageTop,
              }}
            />
          </div>

          {/* Rule-of-thirds guides, inside the frame only. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded opacity-30">
            <div className="absolute left-1/3 top-0 h-full w-px bg-white mix-blend-difference" />
            <div className="absolute left-2/3 top-0 h-full w-px bg-white mix-blend-difference" />
            <div className="absolute left-0 top-1/3 h-px w-full bg-white mix-blend-difference" />
            <div className="absolute left-0 top-2/3 h-px w-full bg-white mix-blend-difference" />
          </div>
        </div>
      )}
    </div>
  );
}
