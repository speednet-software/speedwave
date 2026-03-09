import { bootstrapApplication } from '@angular/platform-browser';
import { ErrorHandler, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { GlobalErrorHandler } from './app/error-handler';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
}).catch((err) => {
  import('@tauri-apps/plugin-log')
    .then(({ error }) => error(`[Bootstrap] ${String(err)}`))
    .catch(() => {});
  console.error(err);
});
