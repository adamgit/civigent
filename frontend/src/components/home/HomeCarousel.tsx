import { type ReactNode, useState } from "react";
import { CIVIGENT_GITHUB_URL } from "../../pages/home/home-constants";

export interface HomeCarouselSlide {
  id: string;
  title: string;
  content: ReactNode;
}

interface HomeCarouselProps {
  slides: HomeCarouselSlide[];
}

export function HomeCarousel({ slides }: HomeCarouselProps) {
  const [index, setIndex] = useState(0);
  if (slides.length === 0) return null;

  const current = slides[index]!;
  const next = slides[(index + 1) % slides.length]!;

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
      <div className="home-carousel__side">
        {slides.length > 1 ? (
          <button
            type="button"
            className="home-card home-mini-card"
            onClick={() => setIndex((i) => (i + 1) % slides.length)}
          >
            <span className="home-mini-card__kicker">Next</span>
            <span className="home-mini-card__title">{next.title}</span>
          </button>
        ) : null}
        <a href={CIVIGENT_GITHUB_URL} className="home-card home-mini-card">
          <span className="home-mini-card__kicker">GitHub</span>
          <span className="home-mini-card__title">adamgit/civigent {"\u2192"}</span>
        </a>
      </div>
    </div>
  );
}
