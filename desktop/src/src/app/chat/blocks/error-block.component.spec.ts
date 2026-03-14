import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ErrorBlockComponent } from './error-block.component';

describe('ErrorBlockComponent', () => {
  let component: ErrorBlockComponent;
  let fixture: ComponentFixture<ErrorBlockComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ErrorBlockComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ErrorBlockComponent);
    component = fixture.componentInstance;
  });

  it('renders error content', () => {
    component.content = 'Something went wrong';
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Something went wrong');
  });

  it('applies error-block class', () => {
    component.content = 'Error';
    fixture.detectChanges();

    const errorBlock = fixture.nativeElement.querySelector('.error-block');
    expect(errorBlock).not.toBeNull();
  });
});
