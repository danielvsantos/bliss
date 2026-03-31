import React, { InputHTMLAttributes, forwardRef, useState, useId } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  success?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      hint,
      error,
      leftIcon,
      rightIcon,
      success,
      className = "",
      id: idProp,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const id = idProp ?? generatedId;
    const hasError = !!error;

    const borderColor = hasError
      ? "#E5989B"
      : success
      ? "#2E8B57"
      : "#E2E8F0";

    const focusShadow = hasError
      ? "0 0 0 2px #FAFAFA, 0 0 0 4px #E5989B"
      : success
      ? "0 0 0 2px #FAFAFA, 0 0 0 4px #2E8B57"
      : "0 0 0 2px #FAFAFA, 0 0 0 4px #6D657A";

    return (
      <div className="flex flex-col gap-1.5 w-full" style={{ fontFamily: "'Urbanist', sans-serif" }}>
        {/* Label */}
        {label && (
          <label
            htmlFor={id}
            style={{
              fontSize: "0.875rem",
              fontWeight: 500,
              color: hasError ? "#c97c7f" : "#3A3542",
              letterSpacing: "0.005em",
              lineHeight: 1.5,
            }}
          >
            {label}
          </label>
        )}

        {/* Input wrapper */}
        <div className="relative flex items-center">
          {leftIcon && (
            <span
              className="absolute left-3.5 flex items-center pointer-events-none"
              style={{ color: "#9A95A4" }}
            >
              {leftIcon}
            </span>
          )}

          <InputField
            ref={ref}
            id={id}
            hasError={hasError}
            success={success}
            leftIcon={leftIcon}
            rightIcon={rightIcon}
            borderColor={borderColor}
            focusShadow={focusShadow}
            className={className}
            {...props}
          />

          {rightIcon && (
            <span
              className="absolute right-3.5 flex items-center pointer-events-none"
              style={{ color: "#9A95A4" }}
            >
              {rightIcon}
            </span>
          )}

          {success && !rightIcon && (
            <span className="absolute right-3.5 flex items-center pointer-events-none">
              <CheckIcon />
            </span>
          )}
        </div>

        {/* Hint / Error */}
        {(hint || error) && (
          <p
            style={{
              fontSize: "0.75rem",
              fontWeight: 400,
              color: hasError ? "#c97c7f" : "#9A95A4",
              lineHeight: 1.5,
            }}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";

/* Internal field with focus state */
interface InputFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  hasError?: boolean;
  success?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  borderColor: string;
  focusShadow: string;
}

const InputField = forwardRef<HTMLInputElement, InputFieldProps>(
  ({ hasError, success, leftIcon, rightIcon, borderColor, focusShadow, style, ...props }, ref) => {
    const [focused, setFocused] = useState(false);

    return (
      <input
        ref={ref}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={{
          fontFamily: "'Urbanist', sans-serif",
          fontSize: "0.9375rem",
          fontWeight: 400,
          color: "#1A1625",
          background: "#FAFAFA",
          border: `1px solid ${borderColor}`,
          borderRadius: "0.75rem",
          height: "2.75rem",
          width: "100%",
          paddingLeft: leftIcon ? "2.75rem" : "1rem",
          paddingRight: rightIcon || success ? "2.75rem" : "1rem",
          outline: "none",
          boxShadow: focused
            ? focusShadow
            : "0 1px 2px rgba(58, 53, 66, 0.04)",
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
          ...style,
        }}
        {...props}
      />
    );
  }
);

InputField.displayName = "InputField";

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" fill="#2E8B57" opacity="0.15" />
      <path
        d="M5 8l2 2 4-4"
        stroke="#2E8B57"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
