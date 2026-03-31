import React from "react";

/* ── Capybara mascot — continuous-line flat vector ── */
interface CapybaraIllustrationProps {
  width?: number | string;
  className?: string;
  showCaption?: boolean;
  caption?: string;
  subcaption?: string;
}

export function CapybaraIllustration({
  width = 340,
  className = "",
  showCaption = true,
  caption = "All calm, nothing here.",
  subcaption = "Navigate from the sidebar to explore your bliss dashboard.",
}: CapybaraIllustrationProps) {
  return (
    <div
      className={`flex flex-col items-center gap-7 ${className}`}
      style={{ fontFamily: "'Urbanist', sans-serif" }}
    >
      <svg
        width={width}
        viewBox="0 0 560 440"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: "visible" }}
        aria-label="Bliss mascot capybara illustration"
        role="img"
      >
        {/* ── Ambient decorations ─────────────────────── */}

        {/* Floating circles */}
        <circle cx="46"  cy="92"  r="4"   fill="#EDE9F3" />
        <circle cx="512" cy="108" r="3"   fill="#EDE9F3" />
        <circle cx="530" cy="215" r="5"   fill="#E2E8F0" />
        <circle cx="22"  cy="290" r="2.5" fill="#E2E8F0" />
        <circle cx="486" cy="290" r="3"   fill="#EDE9F3" />
        <circle cx="75"  cy="350" r="2"   fill="#E2E8F0" />

        {/* Large asterisk / sparkle top-right */}
        <g transform="translate(498,155)" stroke="#C4BFD0" strokeWidth="1.5" strokeLinecap="round">
          <line x1="0" y1="-8" x2="0" y2="8" />
          <line x1="-8" y1="0" x2="8" y2="0" />
          <line x1="-5.5" y1="-5.5" x2="5.5" y2="5.5" />
          <line x1="5.5" y1="-5.5" x2="-5.5" y2="5.5" />
        </g>

        {/* Small asterisk near head */}
        <g transform="translate(468,190)" stroke="#C4BFD0" strokeWidth="1.25" strokeLinecap="round">
          <line x1="0" y1="-5.5" x2="0" y2="5.5" />
          <line x1="-5.5" y1="0" x2="5.5" y2="0" />
          <line x1="-4" y1="-4" x2="4" y2="4" />
          <line x1="4" y1="-4" x2="-4" y2="4" />
        </g>

        {/* Small diamond top-left */}
        <g transform="translate(62,128)" stroke="#D4CEDF" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 0,-6 L 5,0 L 0,6 L -5,0 Z" />
        </g>

        {/* Tiny dot cluster */}
        <circle cx="100" cy="190" r="2"   fill="#DDD5EB" opacity="0.6" />
        <circle cx="108" cy="183" r="1.5" fill="#DDD5EB" opacity="0.5" />
        <circle cx="114" cy="192" r="1"   fill="#DDD5EB" opacity="0.4" />

        {/* ── Ground ──────────────────────────────────── */}
        <path
          d="M 28 392 C 110 386 215 394 310 390 C 395 386 475 393 546 389"
          stroke="#C4BFD0" strokeWidth="1.5" strokeLinecap="round"
        />

        {/* Grass tufts left */}
        <path d="M 52,392 Q 54,378 56,392 M 60,392 Q 63,371 66,392"
          stroke="#C4BFD0" strokeWidth="1.25" strokeLinecap="round" />
        <path d="M 78,392 Q 80,381 82,392"
          stroke="#C4BFD0" strokeWidth="1.25" strokeLinecap="round" />

        {/* Grass tufts right */}
        <path d="M 452,392 Q 454,379 456,392 M 460,392 Q 463,372 466,392"
          stroke="#C4BFD0" strokeWidth="1.25" strokeLinecap="round" />
        <path d="M 476,392 Q 478,383 480,392"
          stroke="#C4BFD0" strokeWidth="1.25" strokeLinecap="round" />

        {/* Tiny flowers on ground */}
        {/* Flower left */}
        <g transform="translate(90,390)" stroke="#C4BFD0" strokeWidth="1" strokeLinecap="round" opacity="0.7">
          <circle cx="0" cy="0" r="2" fill="#EDE9F3" stroke="#C4BFD0" strokeWidth="0.75" />
          <line x1="0" y1="-5" x2="0" y2="-9" />
          <line x1="-4" y1="-3" x2="-7" y2="-6" />
          <line x1="4" y1="-3" x2="7" y2="-6" />
        </g>
        {/* Flower right */}
        <g transform="translate(436,390)" stroke="#C4BFD0" strokeWidth="1" strokeLinecap="round" opacity="0.7">
          <circle cx="0" cy="0" r="2" fill="#EDE9F3" stroke="#C4BFD0" strokeWidth="0.75" />
          <line x1="0" y1="-5" x2="0" y2="-9" />
          <line x1="-4" y1="-3" x2="-7" y2="-6" />
          <line x1="4" y1="-3" x2="7" y2="-6" />
        </g>

        {/* ── Back legs (behind body) ─────────────────── */}

        {/* Back-far leg (lower opacity = further away) */}
        <path
          d="M 126,364 L 126,377 Q 126,386 135,386 Q 144,386 144,377 L 144,364"
          stroke="#6D657A" strokeWidth="1.75" fill="#FAFAFA" opacity="0.65"
        />
        {/* Back-near leg */}
        <path
          d="M 150,367 L 150,380 Q 150,389 160,389 Q 170,389 170,380 L 170,367"
          stroke="#6D657A" strokeWidth="2" fill="#FAFAFA"
        />

        {/* ── Body — large rounded barrel ─────────────── */}
        <ellipse
          cx="208" cy="306" rx="130" ry="66"
          stroke="#6D657A" strokeWidth="2.25" fill="#FAFAFA"
        />

        {/* Subtle fur texture on body */}
        <path d="M 150,270 C 168,264 196,267 215,262"
          stroke="#9A95A4" strokeWidth="1" strokeLinecap="round" opacity="0.25" />
        <path d="M 168,255 C 186,249 212,252 230,247"
          stroke="#9A95A4" strokeWidth="1" strokeLinecap="round" opacity="0.2" />
        <path d="M 162,284 C 180,280 205,282 222,278"
          stroke="#9A95A4" strokeWidth="0.875" strokeLinecap="round" opacity="0.18" />

        {/* ── Head ────────────────────────────────────── */}
        {/*
          The capybara head is a large, blocky rounded rectangle.
          The fill covers the body-head overlap, creating a natural neck.
          Path goes clockwise from the neck-top junction.
        */}
        <path
          d="
            M 278,244
            C 284,229 300,217 325,214
            C 342,212 358,212 370,216
            C 396,223 420,237 434,254
            L 438,270
            L 438,284
            C 436,303 426,317 409,323
            C 392,329 371,329 354,323
            C 335,317 318,305 307,290
            C 296,276 292,260 294,246
            Z
          "
          stroke="#6D657A" strokeWidth="2.25" fill="#FAFAFA"
        />

        {/* ── Ears ─────────────────────────────────────── */}

        {/* Back ear */}
        <path
          d="M 325,214 C 320,199 328,183 340,186 C 352,189 355,204 349,214"
          stroke="#6D657A" strokeWidth="1.75" fill="#FAFAFA"
        />
        {/* Inner back ear */}
        <path
          d="M 329,212 C 325,201 330,191 338,193"
          stroke="#C4BFD0" strokeWidth="1" strokeLinecap="round" opacity="0.45"
        />

        {/* Front ear */}
        <path
          d="M 353,212 C 348,197 356,180 368,183 C 380,186 383,202 376,213"
          stroke="#6D657A" strokeWidth="1.75" fill="#FAFAFA"
        />
        {/* Inner front ear */}
        <path
          d="M 357,210 C 352,199 357,189 365,191"
          stroke="#C4BFD0" strokeWidth="1" strokeLinecap="round" opacity="0.45"
        />

        {/* ── Front legs (in front of body) ──────────── */}

        {/* Front-far leg */}
        <path
          d="M 234,362 L 234,376 Q 234,385 243,385 Q 252,385 252,376 L 252,362"
          stroke="#6D657A" strokeWidth="1.75" fill="#FAFAFA" opacity="0.68"
        />
        {/* Front-near leg */}
        <path
          d="M 256,365 L 256,378 Q 256,387 266,387 Q 276,387 276,378 L 276,365"
          stroke="#6D657A" strokeWidth="2" fill="#FAFAFA"
        />

        {/* ── Tail — tiny nub at back-left ────────────── */}
        <path
          d="M 80,296 C 68,290 66,278 74,272 C 78,268 86,272 84,282"
          stroke="#6D657A" strokeWidth="1.5" fill="#FAFAFA"
        />

        {/* ── Face details ─────────────────────────────── */}

        {/* Eye */}
        <circle cx="400" cy="244" r="5.5" fill="#3A3542" />
        <circle cx="398" cy="242" r="2"   fill="white" />
        {/* Subtle specular highlight */}
        <circle cx="403" cy="247" r="1"   fill="white" opacity="0.5" />

        {/* Brow — very subtle arch */}
        <path
          d="M 392,235 Q 400,230 408,234"
          stroke="#6D657A" strokeWidth="1.25" strokeLinecap="round" opacity="0.45"
        />

        {/* Nostrils */}
        <ellipse cx="434" cy="268" rx="2.5" ry="1.75" fill="#9A95A4" opacity="0.5" />
        <ellipse cx="434" cy="276" rx="2.5" ry="1.75" fill="#9A95A4" opacity="0.5" />

        {/* Whisker dots */}
        <circle cx="422" cy="260" r="1.75" fill="#9A95A4" opacity="0.38" />
        <circle cx="420" cy="268" r="1.75" fill="#9A95A4" opacity="0.38" />
        <circle cx="420" cy="276" r="1.75" fill="#9A95A4" opacity="0.38" />
        <circle cx="425" cy="252" r="1.5"  fill="#9A95A4" opacity="0.3" />

        {/* Mouth — slight upward curve (serene expression) */}
        <path
          d="M 438,283 Q 427,296 412,299"
          stroke="#9A95A4" strokeWidth="1.25" strokeLinecap="round" opacity="0.5"
        />

        {/* ── Floating "bliss" decorations ─────────────── */}

        {/* Zzz floats above head */}
        <text
          x="452" y="140"
          fontFamily="'Urbanist', sans-serif"
          fontSize="13"
          fontWeight="600"
          fill="#C4BFD0"
          letterSpacing="0.04em"
          opacity="0.8"
        >
          zzz
        </text>

        {/* Tiny heart near face */}
        <path
          d="M 464 224 C 464 221.5 466.5 219 469 221.5 C 471.5 219 474 221.5 474 224 C 474 227 469 231 469 231 C 469 231 464 227 464 224 Z"
          fill="#E5989B" opacity="0.55"
        />
      </svg>

      {/* Empty state text */}
      {showCaption && (
        <div className="flex flex-col items-center gap-2 text-center px-6">
          <h3
            style={{
              fontFamily: "'Urbanist', sans-serif",
              fontSize: "1.125rem",
              fontWeight: 600,
              color: "#1A1625",
              letterSpacing: "-0.01em",
              lineHeight: 1.3,
              margin: 0,
            }}
          >
            {caption}
          </h3>
          <p
            style={{
              fontFamily: "'Urbanist', sans-serif",
              fontSize: "0.875rem",
              fontWeight: 400,
              color: "#9A95A4",
              lineHeight: 1.6,
              maxWidth: 300,
              margin: 0,
            }}
          >
            {subcaption}
          </p>
        </div>
      )}
    </div>
  );
}
