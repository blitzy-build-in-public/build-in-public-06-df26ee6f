/**
 * The browser entry: mount the application into the document's `#root` element.
 *
 * `frontend/index.html` is the document that loads this module, as
 * `<script type="module" src="/src/main.tsx">`, and the one that links `styles/global.css`. The
 * stylesheet is therefore deliberately *not* imported here: a second import would emit it twice into
 * the bundle and duplicate every custom property it publishes.
 *
 * The module owns the mount and nothing else. The API client, the list state and the screen's
 * composition belong to `App`, which is the interface's only wiring point; this file must not build a
 * client, hold state, read an environment variable or add a wrapper element around the rendered tree.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

// A `<script type="module">` is deferred until the document has been parsed, so the mount point is
// already in the document by the time this module runs and no readiness check is needed. The lookup
// is checked rather than asserted: the document declares `<div id="root"></div>`, so a missing
// element means the bundle is running against a document it was not built for, which is a failure to
// report rather than a state to recover from.
const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Cannot mount the application: no #root element was found in the document.');
}

// `StrictMode` is React's convention for an application entry. It deliberately double-invokes effects
// in development, which is why the list effect in `state/useTasks.ts` recognises the duplicate run and
// starts no second request for the same load; an answer to a superseded load is still discarded by the
// load it belongs to.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
