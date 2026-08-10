/**
 * 桌面宠物窗口入口。
 *
 * 通过 window.petBridge 与主进程通信：拉取配置、订阅 AI 活动状态与
 * OS 拖拽方向（左/右奔跑）。窗口移动由 CSS `-webkit-app-region: drag`
 * 交给操作系统处理。
 */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type {
  PetActivityState,
  PetWindowConfig,
} from "../preload/types/pets";
import type { PetSpriteState } from "./components/pet/petSprites";
import { PetStage } from "./components/pet/PetStage";
import "./pet.css";

function PetWindowApp(): React.JSX.Element | null {
  const [config, setConfig] = useState<PetWindowConfig | null>(null);
  const [activity, setActivity] = useState<PetActivityState>("idle");
  const [dragState, setDragState] = useState<PetSpriteState | null>(null);

  useEffect(() => {
    const bridge = window.petBridge;
    if (!bridge) {
      return;
    }

    // 先登记广播订阅，再拉取初始值：订阅之后的状态变化必然经广播送达，
    // 订阅之前的状态由拉取补齐。若顺序颠倒，先启动会话再唤醒宠物时，
    // 窗口创建时刻的活动状态广播会在页面加载前发出而永久丢失。
    const unsubscribeConfig = bridge.onConfigChanged(setConfig);
    const unsubscribeActivity = bridge.onActivityChanged(setActivity);
    const unsubscribeDrag = bridge.onDragStateChanged(setDragState);

    bridge.getConfig().then((initial) => {
      if (initial) {
        setConfig(initial);
      }
    });
    bridge.getActivity().then((initialActivity) => {
      setActivity(initialActivity);
    });

    return () => {
      unsubscribeConfig();
      unsubscribeActivity();
      unsubscribeDrag();
    };
  }, []);

  if (!config || !config.manifest) {
    return null;
  }

  return (
    <div className="pet-window">
      <PetStage
        manifest={config.manifest}
        scale={config.settings.scale}
        activity={activity}
        dragState={dragState}
      />
    </div>
  );
}

const container = document.getElementById("pet-root");
if (container) {
  createRoot(container).render(<PetWindowApp />);
}
