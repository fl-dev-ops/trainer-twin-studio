"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface MessagesSquareIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface MessagesSquareIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const PRIMARY_BUBBLE_VARIANTS: Variants = {
  normal: {
    scale: 1,
    rotate: 0,
    pathLength: 1,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
  animate: {
    scale: [1, 1.08, 0.95, 1.03, 1],
    rotate: [0, -4, 3, -1, 0],
    pathLength: [0.85, 1],
    transition: {
      duration: 0.5,
      ease: "easeInOut",
    },
  },
};

const SECONDARY_BUBBLE_VARIANTS: Variants = {
  normal: {
    scale: 1,
    x: 0,
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
  animate: {
    scale: [1, 1.12, 0.98, 1.04, 1],
    x: [0, 1.5, -0.5, 0],
    y: [0, -1.5, 0.5, 0],
    transition: {
      delay: 0.08,
      duration: 0.5,
      ease: "easeInOut",
    },
  },
};

const MessagesSquareIcon = forwardRef<
  MessagesSquareIconHandle,
  MessagesSquareIconProps
>(({ onMouseEnter, onMouseLeave, className, size = 20, ...props }, ref) => {
  const controls = useAnimation();
  const isControlledRef = useRef(false);

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;
    return {
      startAnimation: () => controls.start("animate"),
      stopAnimation: () => controls.start("normal"),
    };
  });

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseEnter?.(e);
      } else {
        controls.start("animate");
      }
    },
    [controls, onMouseEnter],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseLeave?.(e);
      } else {
        controls.start("normal");
      }
    },
    [controls, onMouseLeave],
  );

  return (
    <div
      className={cn("inline-flex items-center justify-center select-none", className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...props}
    >
      <svg
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        className="overflow-visible"
      >
        {/* Front main speech bubble */}
        <motion.path
          animate={controls}
          d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"
          variants={PRIMARY_BUBBLE_VARIANTS}
          style={{ originX: "6px", originY: "9px" }}
        />
        {/* Back secondary speech bubble */}
        <motion.path
          animate={controls}
          d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"
          variants={SECONDARY_BUBBLE_VARIANTS}
          style={{ originX: "18px", originY: "15px" }}
        />
      </svg>
    </div>
  );
});

MessagesSquareIcon.displayName = "MessagesSquareIcon";

export { MessagesSquareIcon };
