import { Button } from '@logbird/ui/components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { clips } from '../lib/media-manifest';
export function Clip({ id }: { id: string }) {
  const entry = clips.find((item) => item.id === id);
  const ref = useRef<HTMLVideoElement>(null);
  const userPaused = useRef(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video || !entry) {
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
    let visible = false;
    const update = () => {
      if (visible && motion.matches && !userPaused.current) {
        video.play().catch(() => setPlaying(false));
      } else {
        video.pause();
      }
    };
    const observer = new IntersectionObserver(
      ([result]) => {
        visible = !!result?.isIntersecting;
        update();
      },
      { threshold: 0.25 },
    );
    observer.observe(video);
    motion.addEventListener('change', update);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
      video.pause();
    };
  }, [entry]);
  if (!entry) {
    throw new Error(`Unknown clip: ${id}`);
  }
  return (
    <figure className="clip">
      <video
        ref={ref}
        src={`/media/${entry.id}.webm`}
        poster={`/media/${entry.id}-poster.webp`}
        muted
        playsInline
        loop
        preload="none"
        aria-label={entry.alt}
        aria-describedby={`${id}-caption`}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <figcaption id={`${id}-caption`}>{entry.alt}</figcaption>
      <Button
        variant="outline"
        type="button"
        aria-label={`${playing ? 'Pause' : 'Play'} ${id} video`}
        onClick={() => {
          const video = ref.current;
          if (!video) {
            return;
          }
          userPaused.current = !video.paused;
          if (video.paused) {
            video.play().catch(() => setPlaying(false));
          } else {
            video.pause();
          }
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </Button>
    </figure>
  );
}
