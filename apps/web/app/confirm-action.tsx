"use client";
import { useId, useRef } from "react";

// A button that asks before it acts, in place of window.confirm.
export default function ConfirmAction({
  label,
  title,
  body,
  confirmLabel,
  onConfirm,
  disabled,
  danger,
  className = "btn",
  ariaLabel,
}: {
  label: React.ReactNode;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog ref={dialog} className="confirm" aria-labelledby={id}>
        <form method="dialog">
          <h2 id={id}>{title}</h2>
          <p>{body}</p>
          <div className="confirm-actions">
            <button className="btn" value="cancel">
              Cancel
            </button>
            <button
              className={danger ? "btn btn-danger" : "btn btn-primary"}
              value="confirm"
              onClick={(event) => {
                event.preventDefault();
                dialog.current?.close();
                onConfirm();
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
