import type { ImgHTMLAttributes } from 'react';

/**
 * `next/image` 的替身。
 *
 * Next 的图片组件会在构建时做尺寸优化 + 生成 srcset，那需要服务端。
 * 桌面版的图片都是本地 `app://` 下的静态资源或直接是 `/api/...` 的二进制响应，
 * 退化成原生 `<img>` 就是正确行为。
 */
type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt?: string;
  fill?: boolean;
  priority?: boolean;
  unoptimized?: boolean;
};

export default function Image({ src, alt = '', fill, priority, unoptimized, ...rest }: Props) {
  return (
    <img
      src={src}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(fill ? { style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } } : {})}
      {...rest}
    />
  );
}
