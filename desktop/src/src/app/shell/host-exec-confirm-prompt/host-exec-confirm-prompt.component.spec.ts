import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HostExecConfirmPromptComponent } from './host-exec-confirm-prompt.component';
import { TauriService } from '../../services/tauri.service';
import { LoggerService } from '../../services/logger.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * A confirm-request event payload.
 * @param over - Fields to override on the default request.
 */
function req(
  over?: Partial<{ project: string; recipe: string; argv: string[]; cwd: string; id: string }>
) {
  return {
    project: 'proj-a',
    recipe: 'gradle_test',
    argv: ['./gradlew', 'test'],
    cwd: '.',
    id: 'r1',
    ...over,
  };
}

describe('HostExecConfirmPromptComponent', () => {
  let fixture: ComponentFixture<HostExecConfirmPromptComponent>;
  let component: HostExecConfirmPromptComponent;
  let mockTauri: MockTauriService;
  let invokeCalls: { cmd: string; args?: Record<string, unknown> }[];
  let responses: Record<string, unknown>;

  beforeEach(async () => {
    invokeCalls = [];
    responses = {};
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd in responses) {
        const r = responses[cmd];
        if (r instanceof Error) throw r;
        return r;
      }
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [HostExecConfirmPromptComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: makeMockLogger() },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostExecConfirmPromptComponent);
    component = fixture.componentInstance;
    await component.ngOnInit();
    fixture.detectChanges();
  });

  const q = (sel: string) =>
    (fixture.nativeElement as HTMLElement).querySelector(sel) as HTMLElement | null;

  it('subscribes to the confirm-request event on init', () => {
    expect(mockTauri.listenHandlers['host-exec://confirm-request']).toBeDefined();
    // No dialog until an event arrives.
    expect(q('[data-testid="host-exec-confirm"]')).toBeNull();
  });

  it('shows a dialog on a confirm-request event and replies "allow"', async () => {
    mockTauri.dispatchEvent('host-exec://confirm-request', req({ id: 'req-1' }));
    fixture.detectChanges();
    expect(q('[data-testid="host-exec-confirm"]')).not.toBeNull();
    expect(q('[data-testid="host-exec-confirm-argv"]')?.textContent).toContain('./gradlew test');
    expect(q('[data-testid="host-exec-confirm-title"]')?.textContent).toContain('gradle_test');
    q('[data-testid="host-exec-confirm-allow"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('[data-testid="host-exec-confirm"]')).toBeNull();
    expect(invokeCalls.find((c) => c.cmd === 'host_exec_confirm_reply')?.args).toEqual({
      project: 'proj-a',
      id: 'req-1',
      decision: 'allow',
    });
  });

  it('replies "deny" and "allow-session" via the respective buttons', async () => {
    mockTauri.dispatchEvent('host-exec://confirm-request', req({ id: 'req-deny' }));
    fixture.detectChanges();
    q('[data-testid="host-exec-confirm-deny"]')!.click();
    await fixture.whenStable();
    expect(invokeCalls.find((c) => c.cmd === 'host_exec_confirm_reply')?.args?.['decision']).toBe(
      'deny'
    );
    invokeCalls.length = 0;
    mockTauri.dispatchEvent('host-exec://confirm-request', req({ id: 'req-sess' }));
    fixture.detectChanges();
    q('[data-testid="host-exec-confirm-session"]')!.click();
    await fixture.whenStable();
    expect(invokeCalls.find((c) => c.cmd === 'host_exec_confirm_reply')?.args?.['decision']).toBe(
      'allow-session'
    );
  });

  it('queues multiple requests and shows them one at a time', async () => {
    mockTauri.dispatchEvent('host-exec://confirm-request', req({ id: 'q1' }));
    mockTauri.dispatchEvent(
      'host-exec://confirm-request',
      req({ id: 'q2', argv: ['./gradlew', 'lint'] })
    );
    fixture.detectChanges();
    expect(component.active?.id).toBe('q1');
    q('[data-testid="host-exec-confirm-allow"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.active?.id).toBe('q2');
    expect(q('[data-testid="host-exec-confirm-argv"]')?.textContent).toContain('./gradlew lint');
  });

  it('shows requests for any project (the worker is per-project; the user must authorise it regardless)', async () => {
    mockTauri.dispatchEvent(
      'host-exec://confirm-request',
      req({ project: 'some-other-project', id: 'x' })
    );
    fixture.detectChanges();
    expect(component.active?.project).toBe('some-other-project');
    expect(q('[data-testid="host-exec-confirm"]')).not.toBeNull();
    // The reply carries the request's own project.
    q('[data-testid="host-exec-confirm-allow"]')!.click();
    await fixture.whenStable();
    expect(invokeCalls.find((c) => c.cmd === 'host_exec_confirm_reply')?.args?.['project']).toBe(
      'some-other-project'
    );
  });

  it('a failing host_exec_confirm_reply is swallowed (worker fails closed) — dialog still closes', async () => {
    responses['host_exec_confirm_reply'] = new Error('no live worker');
    mockTauri.dispatchEvent('host-exec://confirm-request', req({ id: 'req-err' }));
    fixture.detectChanges();
    q('[data-testid="host-exec-confirm-allow"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('[data-testid="host-exec-confirm"]')).toBeNull();
    expect(component.active).toBeNull();
  });

  it('unsubscribes on destroy', () => {
    expect(mockTauri.listenHandlers['host-exec://confirm-request']).toBeDefined();
    fixture.destroy();
    expect(mockTauri.listenHandlers['host-exec://confirm-request']).toBeUndefined();
  });
});
