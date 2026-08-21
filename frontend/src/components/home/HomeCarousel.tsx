import { type ReactNode, useEffect, useState } from "react";

export interface HomeCarouselSlide {
  id: string;
  title: string;
  content: ReactNode;
}

interface HomeCarouselProps {
  slides: HomeCarouselSlide[];
}

const CYCLE_MS = 16000;

function EdgeChevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 10 24" width="8" height="18" aria-hidden="true">
      {dir === "prev" ? (
        <path d="M7.5 3.5 L2 12 L7.5 20.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M2.5 3.5 L8 12 L2.5 20.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

type Motion = "slide" | "fade";

function slideClass(
  i: number,
  index: number,
  outgoing: number | null,
  dir: 1 | -1,
  motion: Motion | null,
  slideId: string,
): string {
  const classes = ["home-carousel__slide"];
  if (slideId === "single-user") classes.push("home-slide--single-user");
  if (i === index) {
    if (outgoing == null || motion == null) classes.push("home-carousel__slide--active");
    else if (motion === "fade") classes.push("home-carousel__slide--fade-in");
    else classes.push(dir === 1 ? "home-carousel__slide--in-right" : "home-carousel__slide--in-left");
  } else if (i === outgoing) {
    if (motion === "fade") classes.push("home-carousel__slide--fade-out");
    else classes.push(dir === 1 ? "home-carousel__slide--out-left" : "home-carousel__slide--out-right");
  }
  return classes.join(" ");
}

export function HomeCarousel({ slides }: HomeCarouselProps) {
  const [index, setIndex] = useState(0);
  const [outgoing, setOutgoing] = useState<number | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [motion, setMotion] = useState<Motion | null>(null);

  const go = (step: 1 | -1, nextMotion: Motion) => {
    if (slides.length < 2) return;
    setMotion(nextMotion);
    setDir(step);
    setOutgoing(index);
    setIndex((index + step + slides.length) % slides.length);
  };

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = window.setInterval(() => go(1, "fade"), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [slides.length, index]);

  if (slides.length === 0) return null;

  return (
    <div className="home-carousel">
      <div className="home-card home-carousel__main">
        {slides.length > 1 ? (
          <button
            type="button"
            className="home-carousel__edge home-carousel__edge--prev"
            aria-label="Previous"
            onClick={() => go(-1, "slide")}
          >
            <EdgeChevron dir="prev" />
          </button>
        ) : null}
        <div className="home-carousel__slides">
          {slides.map((slide, i) => (
            <div
              key={slide.id}
              className={slideClass(i, index, outgoing, dir, motion, slide.id)}
              aria-hidden={i !== index}
              inert={i !== index ? true : undefined}
            >
              <div className="home-slide">
                <div className="home-slide__kicker">{slide.title}</div>
                {slide.content}
              </div>
            </div>
          ))}
        </div>
        {slides.length > 1 ? (
          <button
            type="button"
            className="home-carousel__edge home-carousel__edge--next"
            aria-label="Next"
            onClick={() => go(1, "slide")}
          >
            <EdgeChevron dir="next" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
