/**
 * 宠物预览：绘制精灵图 idle 行第一帧的缩略图（设置列表用）。
 */
import { useEffect, useRef } from "react";
import { themeBgUrl } from "../../utils/themeBgUrl";

type PetPreviewProps = {
  spritesheetPath: string;
  /** 预览画布边长（像素） */
  size?: number;
};

export function PetPreview({
  spritesheetPath,
  size = 36,
}: PetPreviewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) {
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      // 只取第一行第一帧（idle 首帧）；按 8 列网格估算帧尺寸。
      const frameWidth = image.naturalWidth / 8;
      const frameHeight = image.naturalHeight / Math.max(9, Math.round(image.naturalHeight / 208));
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const drawWidth = size;
      const drawHeight = (frameHeight / frameWidth) * size;
      ctx.drawImage(
        image,
        0,
        0,
        frameWidth,
        frameHeight,
        0,
        canvas.height - drawHeight,
        drawWidth,
        drawHeight
      );
    };
    image.src = themeBgUrl(spritesheetPath);
    return () => {
      cancelled = true;
    };
  }, [spritesheetPath, size]);

  return (
    <canvas
      ref={canvasRef}
      className="pets-preview-canvas"
      width={size}
      height={size}
    />
  );
}
