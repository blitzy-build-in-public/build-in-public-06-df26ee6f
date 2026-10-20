/**
 * ConfirmDialog — the modal confirmation that stands between a destructive control and the
 * request it would make.
 *
 * It renders a native `<dialog>` element in modal mode: `showModal()` puts the element in
 * the browser's top layer, moves focus inside it and makes the rest of the page inert, so
 * Cancel, Escape and a click on the backdrop each dismiss it with nothing changed, while
 * only the confirm control acts. This component never moves focus itself — the browser
 * places focus when the modal opens and returns it to the control that opened it when the
 * dialog closes — and it holds no state: the `open` prop is the single source of truth for
 * whether the dialog is shown.
 *
 * jsdom, the DOM the component tests run in, implements no part of the modal API: there
 * `showModal`, `show` and `close` are all absent and the reflected `open` attribute is the
 * whole of what exists. The effects below therefore feature-detect each call and fall back
 * to that attribute, which keeps the component's own contents queryable while it is open.
 */

import { useEffect, useId, useRef } from 'react';
import type { MouseEvent } from 'react';

import styles from './ConfirmDialog.module.css';

/**
 * Props of {@link ConfirmDialog}.
 *
 * The component is deliberately given no task, no client and no state of its own: its caller
 * names what is being confirmed through `title` and `message`, and decides what either
 * answer does.
 */
export interface ConfirmDialogProps {
  /** Whether the dialog is shown. `false` closes an open dialog; nothing here toggles it. */
  open: boolean;
  /** The dialog's heading, rendered as an `<h2>`, naming what is being confirmed. */
  title: string;
  /** The confirmation copy, announced with the dialog as its description. */
  message: string;
  /** The visible text of the confirm control, for example `Delete`. */
  confirmLabel: string;
  /** Called when the user confirms. Reached through the confirm control alone. */
  onConfirm: () => void;
  /** Called when the user dismisses the dialog: Cancel, Escape or a click on the backdrop. */
  onCancel: () => void;
}

/**
 * Renders the confirmation as a native modal dialog and reports which choice was made.
 *
 * Nothing is confirmed implicitly: `onConfirm` is called by the confirm control and by
 * nothing else, and every other way out of the dialog — Cancel, Escape, a click on the
 * backdrop — calls `onCancel`. The dialog stays in the document while it is closed, where
 * the browser's own stylesheet hides it, so its contents reach no pointer, keyboard or
 * screen reader until it opens.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Stable ids, so the dialog is announced with the heading that names the task and the
  // message that explains what confirming will do.
  const titleId = useId();
  const messageId = useId();

  // The prop drives the element. Showing a modal that is already open throws
  // InvalidStateError, so the check precedes the call and a second run of this effect —
  // React StrictMode runs effects twice in development — is a no-op.
  useEffect(() => {
    const element = dialogRef.current;

    if (element === null) {
      return;
    }

    if (open) {
      if (typeof element.showModal === 'function') {
        if (!element.open) {
          element.showModal();
        }
      } else {
        element.setAttribute('open', '');
      }
    } else if (element.open) {
      if (typeof element.close === 'function') {
        element.close();
      } else {
        element.removeAttribute('open');
      }
    }
  }, [open]);

  // Escape. The browser fires `cancel` before dismissing the dialog itself, and the listener
  // is attached natively because that default dismissal is what returns focus to the control
  // that opened the dialog. `preventDefault` is deliberately not called: the parent's
  // `onCancel` sets `open` to false, after which the effect above finds the dialog already
  // closed and leaves it alone.
  useEffect(() => {
    const element = dialogRef.current;

    if (element === null) {
      return;
    }

    function handleCancelEvent(): void {
      onCancel();
    }

    element.addEventListener('cancel', handleCancelEvent);

    return () => {
      element.removeEventListener('cancel', handleCancelEvent);
    };
  }, [onCancel]);

  // A modal dialog's backdrop belongs to the dialog element, so a click whose target is the
  // dialog itself landed outside its content. A click on anything inside targets that
  // descendant, and dismisses nothing.
  function handleClick(event: MouseEvent<HTMLDialogElement>): void {
    if (event.target === dialogRef.current) {
      onCancel();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onClick={handleClick}
    >
      <h2 className={styles.title} id={titleId}>
        {title}
      </h2>
      <p className={styles.message} id={messageId}>
        {message}
      </p>
      {/* Cancel precedes the confirm control in DOM order, so the keyboard reaches the safe
          choice first and the destructive one is never the initial focus target. Both
          handlers are invoked with no arguments, so neither answer carries the click event
          into the caller. */}
      <div className={styles.actions}>
        <button type="button" onClick={() => onCancel()}>
          Cancel
        </button>
        <button type="button" onClick={() => onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
