import { bootstrapApplication } from '@angular/platform-browser';
import { CSP_NONCE, ErrorHandler, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { GlobalErrorHandler } from './app/error-handler';

/**
 * Read the nonce Tauri injected into the boot-overlay <style> tag in index.html.
 *  Passing it to CSP_NONCE lets Angular add the same nonce to all component <style> tags.
 */
const tauriNonce = document.getElementById('boot-overlay-style')?.nonce || '';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    // `anchorScrolling: enabled` makes the router scroll an `id="..."`
    // element into view when a navigation carries `fragment="..."` —
    // required for the System health → IDE Bridge `connect →` deep link.
    provideRouter(
      routes,
      withInMemoryScrolling({
        anchorScrolling: 'enabled',
        scrollPositionRestoration: 'enabled',
      })
    ),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    ...(tauriNonce ? [{ provide: CSP_NONCE, useValue: tauriNonce }] : []),
  ],
}).catch((err) => {
  import('@tauri-apps/plugin-log')
    .then(({ error }) => error(`[Bootstrap] ${String(err)}`))
    .catch(() => {});
  console.error(err);
});
