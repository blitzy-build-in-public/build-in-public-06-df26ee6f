/**
 * ConfirmDialog — the modal confirmation that stands between a destructive control and the
 * request it would make.
 *
 * It renders a native `<dialog>` element in modal mode: `showModal()` puts the element in
 * the browser's top layer, moves focus inside it and makes the rest of the page inert, so
 * Cancel, Escape and a click on the backdrop each dismiss it with nothing changed, while
 * only the confirm control acts. It holds no state: the `open` prop is the single source of
 * truth for whether the dialog is shown.
 *
 * Focus is the browser's, with one exception: the platform places focus when the modal opens
 * and returns it to the control that opened the dialog when it closes, and the only move this
 * component makes is the Tab wrap that keeps sequential navigation inside the modal — the top
 * layer alone is not a keyboard trap, so without it the Tab after the dialog's last control
 * lands on the document body, where no focus indicator is drawn. `handleKeyDown` states why.
 *
 * jsdom, the DOM the component tests run in, implements no part of the modal API: there
 * `showModal`, `show` and `close` are all absent and the reflected `open` attribute is the
 * whole of what exists. The effects below therefore feature-detect each call and fall back
 * to that attribute, which keeps the component's own contents queryable while it is open.
 */

import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import styles from './ConfirmDialog.module.css';

/**
 * Every element inside the dialog that sequential navigation can reach: a native control that is
 * not disabled, a link, or anything that opted in through a `tabindex` other than `-1`.
 */
const FOCUSABLE_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The dialog's focusable elements, in the order the keyboard reaches them.
 *
 * @param dialog - The dialog element whose descendants are read.
 * @returns The focusable descendants, with the disabled ones left out.
 */
function getFocusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled'),
  );
}

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
  // dialog itself landed outside the card and dismisses the confirmation. The card's whole box is
  // covered by the content wrapper below — the padding the dialog used to carry of its own now
  // sits on that wrapper — so a click anywhere inside the card, its inner padding included,
  // targets the wrapper or one of its descendants, and dismisses nothing.
  //
  // A press that repeats the one which opened the dialog is not a dismissal. A double-click on a
  // row's Delete asks for the confirmation with its first press and delivers a second one wherever
  // the confirmation has just put the pointer — on the card, or on the backdrop beside it — and
  // treating that second press as a click outside cancelled the confirmation the click before it
  // had just asked for. The browser counts the presses of a single gesture in `event.detail`, so
  // only the first press of a gesture dismisses; a deliberate click still arrives as one.
  function handleClick(event: MouseEvent<HTMLDialogElement>): void {
    if (event.detail > 1) {
      return;
    }

    if (event.target === dialogRef.current) {
      onCancel();
    }
  }

  // The Tab wrap, and the only focus move this component makes. `showModal()` puts the dialog in
  // the browser's top layer and makes the rest of the page inert, but sequential navigation is not
  // trapped there: the Tab pressed on the dialog's last control leaves the dialog for the document
  // body, one stop with nothing focused and no visible focus indicator, and only the press after it
  // comes back inside the dialog. Wrapping the two ends here keeps every Tab stop inside the modal,
  // where the focus ring is drawn. Shift+Tab is wrapped at the other end for the same reason.
  // Nothing else about the platform's own behaviour changes: Escape, the backdrop dismissal and the
  // return of focus to the control that opened the dialog all stay the browser's.
  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== 'Tab') {
      return;
    }

    const element = dialogRef.current;

    if (element === null) {
      return;
    }

    const focusable = getFocusableElements(element);

    // One focusable element, or none, leaves nothing to wrap between, and the browser's own
    // navigation is the right answer for it.
    if (focusable.length < 2) {
      return;
    }

    const first = focusable.at(0);
    const last = focusable.at(-1);

    // The count above rules the absent case out; `noUncheckedIndexedAccess` cannot see that.
    if (first === undefined || last === undefined) {
      return;
    }

    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }

      return;
    }

    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* The card's content, and the element that carries the card's padding, so that the dialog's
          box is covered by this wrapper rather than left exposed as a dismiss region around the
          text. Only a click that lands on the <dialog> element itself — the ::backdrop — reaches
          `handleClick` as a click outside the card. */}
      <div className={styles.content}>
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
      </div>
    </dialog>
  );
}
