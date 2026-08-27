"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface UserRoundIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface UserRoundIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const HEAD_VARIANTS: Variants = {
  normal: {
    y: 0,
    scale: 1,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
  animate: {
    y: [-1, 1, -0.5, 0],
    scale: [1, 1.1, 0.95, 1],
    transition: {
      duration: 0.45,
      ease: "easeInOut",
    },
  },
};

const BODY_VARIANTS: Variants = {
  normal: {
    scale: 1,
    transition: {
      duration: 0.3,
      ease: "easeOut",
    },
  },
  animate: {
    scale: [1, 1.06, 0.98, 1],
    transition: {
      delay: 0.05,
      duration: 0.45,
      ease: "easeInOut",
    },
  },
};

const UserRoundIcon = forwardRef<UserRoundIconHandle, UserRoundIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 20, ...props }, ref) => {
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
          <motion.circle
            animate={controls}
            cx="12"
            cy="8"
            r="5"
            variants={HEAD_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="M20 21a8 8 0 0 0-16 0"
            variants={BODY_VARIANTS}
            style={{ originX: "12px", originY: "21px" }}
          />
        </svg>
      </div>
    );
  },
);

UserRoundIcon.displayName = "UserRoundIcon";

export { UserRoundIcon };
