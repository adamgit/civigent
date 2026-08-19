import { type ReactNode, useEffect, useState } from "react";

export interface HomeCarouselSlide {
  id: string;
  title: string;
  content: ReactNode;
}

interface HomeCarouselProps {
  slides: HomeCarouselSlide[];
}

const CYCLE_MS = 8000;

export function HomeCarousel({ slides }: HomeCarouselProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % slides.length);
    }, CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [slides.length]);

  if (slides.length === 0) return null;

  const current = slides[index] ?? slides[0]!;

  return (
    <div className="home-carousel">
      <div className="home-card home-carousel__main">
        {current.content}
        {slides.length > 1 ? (
          <div className="home-carousel__dots" role="tablist" aria-label="Carousel slides">
            {slides.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={slide.title}
                className={`home-carousel__dot${i === index ? " home-carousel__dot--active" : ""}`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
