import { Component, effect, input, signal } from '@angular/core';
import QRCode from 'qrcode';

/**
 * আসল (স্ক্যানযোগ্য) QR কোড — data টেক্সট/লিংক থেকে PNG ছবি তৈরি করে।
 * <img> হওয়ায় প্রিন্টেও হুবহু আসে। বাংলা টেক্সট UTF-8 হিসেবে এনকোড হয় (সাধারণ ফোন স্ক্যানারে পড়া যায়)।
 */
@Component({
  selector: 'app-qr-code',
  standalone: true,
  template: `
    @if (src()) {
      <img [src]="src()" [width]="size()" [height]="size()" [alt]="alt()" class="qr-img" />
    } @else {
      <span class="qr-placeholder" [style.width.px]="size()" [style.height.px]="size()"></span>
    }
  `,
  styles: [`
    :host { display: inline-block; line-height: 0; }
    .qr-img { display: block; image-rendering: pixelated; }
    .qr-placeholder { display: block; background: #f1f5f9; border-radius: 4px; }
  `]
})
export class QrCodeComponent {
  readonly data = input.required<string>();
  readonly size = input<number>(96);
  readonly alt = input<string>('QR code');

  readonly src = signal<string>('');

  constructor() {
    effect(() => {
      const text = this.data();
      const size = this.size();
      // প্রিন্টে ঝাপসা না হতে ৩ গুণ রেজোলিউশনে তৈরি
      QRCode.toDataURL(text || ' ', { errorCorrectionLevel: 'M', margin: 1, width: size * 3 })
        .then(url => this.src.set(url))
        .catch(err => {
          console.error('QR code generation failed:', err);
          this.src.set('');
        });
    });
  }
}
