import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AttachmentRef } from "@shared/attachments";

export type ViewerImage = Extract<AttachmentRef, { missing: false }>;

interface ViewerApi {
  open: (id: string) => void;
}

const ViewerContext = createContext<ViewerApi>({ open: () => undefined });

export function useViewer(): ViewerApi {
  return useContext(ViewerContext);
}

/** The viewer is its own chunk: a chat without images never downloads it. */
const ImageViewer = lazy(() => import("./image-viewer"));

/** Opens the full-screen viewer over the conversation's images, in transcript order. */
export function ViewerProvider({
  images,
  children,
}: {
  images: readonly ViewerImage[];
  children: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Focus goes back to the thumbnail that opened the viewer.
  const opener = useRef<HTMLElement | null>(null);
  const api = useMemo<ViewerApi>(
    () => ({
      open: (id) => {
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpenId(id);
      },
    }),
    [],
  );
  const index = openId === null ? -1 : images.findIndex((image) => image.id === openId);
  return (
    <ViewerContext.Provider value={api}>
      {children}
      {index >= 0 ? (
        <Suspense fallback={null}>
          <ImageViewer
            images={images}
            index={index}
            onIndex={(next) => {
              const image = images[next];
              if (image) setOpenId(image.id);
            }}
            onClose={() => {
              setOpenId(null);
            }}
            returnFocus={() => opener.current}
          />
        </Suspense>
      ) : null}
    </ViewerContext.Provider>
  );
}
