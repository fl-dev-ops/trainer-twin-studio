"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Box,
  Compass,
  Database,
  ExternalLink,
  Eye,
  Info,
  Maximize2,
  Mic,
  Minimize2,
  Play,
  RotateCcw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { fetchEmbeddings } from "@/lib/knowledge/api";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import type { EmbeddingPoint3D } from "./types";

function createCircleTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.25, "rgba(255, 255, 255, 0.9)");
  gradient.addColorStop(0.6, "rgba(255, 255, 255, 0.4)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

export function Knowledge3DView({
  onSelectDocId,
  isVisible = true,
}: {
  onSelectDocId: (docId: string) => void;
  isVisible?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const {
    data: embeddingsData,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: knowledgeKeys.embeddings(2000),
    queryFn: () => fetchEmbeddings(2000),
    staleTime: 1000 * 60 * 10,
  });

  const pointsData = embeddingsData?.points ?? [];
  const error = queryError instanceof Error ? queryError.message : null;

  // HUD filter: "all" | "knowledge" | "persona"
  const [filterType, setFilterType] = useState<"all" | "knowledge" | "persona">("all");
  const [autoRotate, setAutoRotate] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Hovered point state for 2D UI tooltip
  const [hoveredPoint, setHoveredPoint] = useState<{
    point: EmbeddingPoint3D;
    screenX: number;
    screenY: number;
  } | null>(null);

  // Voice snippet modal for persona voice clicks
  const [selectedVoicePoint, setSelectedVoicePoint] = useState<EmbeddingPoint3D | null>(null);

  const controlsRef = useRef<OrbitControls | null>(null);
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  // Trigger resize event when becoming visible
  useEffect(() => {
    if (isVisible) {
      window.dispatchEvent(new Event("resize"));
    }
  }, [isVisible]);

  // Three.js Scene Setup & Render Loop
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || loading || pointsData.length === 0) return;
    const canvasEl = canvas;

    // Filter points
    const activePoints = pointsData.filter((p) => {
      if (filterType === "knowledge") return p.type === "knowledge";
      if (filterType === "persona") return p.type === "persona_voice";
      return true;
    });

    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 25, 55);

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    const controls = new OrbitControls(camera, canvasEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.8;
    controls.maxDistance = 150;
    controls.minDistance = 5;
    controlsRef.current = controls;

    // Grid Floor
    const grid = new THREE.GridHelper(70, 28, 0x3b82f6, 0x1e293b);
    grid.position.y = -30;
    (grid.material as THREE.Material).opacity = 0.25;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // Subtle ambient lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    // Points Geometry
    const pointCount = activePoints.length;
    const positions = new Float32Array(pointCount * 3);
    const colors = new Float32Array(pointCount * 3);

    const colorKnowledge = new THREE.Color("#3b82f6"); // neon blue
    const colorVoice = new THREE.Color("#10b981"); // neon green

    for (let i = 0; i < pointCount; i++) {
      const p = activePoints[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;

      const c = p.type === "persona_voice" ? colorVoice : colorKnowledge;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const circleTexture = createCircleTexture();
    const material = new THREE.PointsMaterial({
      size: 1.4,
      vertexColors: true,
      map: circleTexture,
      transparent: true,
      opacity: 0.9,
      alphaTest: 0.01,
      sizeAttenuation: true,
    });

    const pointsMesh = new THREE.Points(geometry, material);
    scene.add(pointsMesh);

    // Highlight marker for hovered point
    const highlightGeo = new THREE.SphereGeometry(0.8, 16, 16);
    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    });
    const highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);
    highlightMesh.visible = false;
    scene.add(highlightMesh);

    // Outer glow ring
    const ringGeo = new THREE.RingGeometry(1.2, 1.5, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.visible = false;
    scene.add(ringMesh);

    // Raycaster for mouse interaction
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.5 };
    const mouse = new THREE.Vector2(-1000, -1000);

    function onPointerMove(e: MouseEvent) {
      const rect = canvasEl.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(pointsMesh);

      if (intersects.length > 0 && intersects[0].index !== undefined) {
        const index = intersects[0].index;
        const pt = activePoints[index];
        if (pt) {
          canvasEl.style.cursor = "pointer";
          highlightMesh.position.set(pt.x, pt.y, pt.z);
          highlightMesh.visible = true;

          ringMesh.position.set(pt.x, pt.y, pt.z);
          ringMesh.lookAt(camera.position);
          ringMesh.visible = true;

          setHoveredPoint({
            point: pt,
            screenX: e.clientX - rect.left,
            screenY: e.clientY - rect.top,
          });
          return;
        }
      }

      canvasEl.style.cursor = "default";
      highlightMesh.visible = false;
      ringMesh.visible = false;
      setHoveredPoint(null);
    }

    function onClick(e: MouseEvent) {
      const rect = canvasEl.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObject(pointsMesh);

      if (intersects.length > 0 && intersects[0].index !== undefined) {
        const index = intersects[0].index;
        const pt = activePoints[index];
        if (pt) {
          if (pt.type === "knowledge" && pt.docId) {
            onSelectDocId(pt.docId);
          } else if (pt.type === "persona_voice") {
            setSelectedVoicePoint(pt);
          }
        }
      }
    }

    canvasEl.addEventListener("mousemove", onPointerMove);
    canvasEl.addEventListener("click", onClick);

    // Animation loop
    let animId: number;
    let clock = new THREE.Clock();

    function animate() {
      animId = requestAnimationFrame(animate);
      if (!isVisibleRef.current) return;
      const elapsed = clock.getElapsedTime();

      controls.autoRotate = autoRotateRef.current;
      controls.update();

      if (ringMesh.visible) {
        const scale = 1 + Math.sin(elapsed * 6) * 0.15;
        ringMesh.scale.set(scale, scale, scale);
        ringMesh.lookAt(camera.position);
      }

      renderer.render(scene, camera);
    }
    animate();

    // Resize handling
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(animId);
      canvasEl.removeEventListener("mousemove", onPointerMove);
      canvasEl.removeEventListener("click", onClick);
      resizeObserver.disconnect();
      geometry.dispose();
      material.dispose();
      highlightGeo.dispose();
      highlightMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      circleTexture.dispose();
      renderer.dispose();
    };
  }, [pointsData, loading, filterType, onSelectDocId]);

  function resetCamera() {
    if (controlsRef.current) {
      controlsRef.current.reset();
    }
  }

  const knowledgeCount = pointsData.filter((p) => p.type === "knowledge").length;
  const personaCount = pointsData.filter((p) => p.type === "persona_voice").length;

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden rounded-2xl border bg-gradient-to-b from-card to-background shadow-xs select-none ${
        isFullscreen
          ? "fixed inset-0 z-50 h-screen rounded-none border-none"
          : "h-[620px] sm:h-[680px]"
      }`}
    >
      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/80 backdrop-blur-xs">
          <Spinner className="size-8 text-primary" />
          <p className="mt-3 text-sm font-medium text-foreground">
            Projecting 1,536D vectors into 3D space with PCA...
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fetching embeddings from your organization Chroma collection
          </p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center">
          <Info className="size-8 text-destructive" />
          <p className="mt-3 text-sm font-medium text-foreground">Could not render 3D Point Cloud</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-sm">{error}</p>
        </div>
      )}

      {/* Empty points state */}
      {!loading && !error && pointsData.length === 0 && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center">
          <Box className="size-10 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium text-foreground">No embeddings in ChromaDB yet</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-sm">
            Upload documents or add persona voice memories to visualize them in 3D vector space.
          </p>
        </div>
      )}

      {/* WebGL Canvas */}
      <canvas ref={canvasRef} className="h-full w-full block" />

      {/* Top HUD Bar */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex flex-wrap items-center justify-between gap-3 p-4">
        {/* Filter Pills */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border bg-background/80 p-1 backdrop-blur-md shadow-xs">
          <Button
            variant={filterType === "all" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilterType("all")}
            className="h-7 text-xs px-2.5"
          >
            All Vectors ({pointsData.length})
          </Button>
          <Button
            variant={filterType === "knowledge" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilterType("knowledge")}
            className="h-7 text-xs px-2.5 gap-1.5"
          >
            <span className="size-2 rounded-full bg-blue-500" />
            <span>Documents ({knowledgeCount})</span>
          </Button>
          <Button
            variant={filterType === "persona" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilterType("persona")}
            className="h-7 text-xs px-2.5 gap-1.5"
          >
            <span className="size-2 rounded-full bg-emerald-500" />
            <span>Persona ({personaCount})</span>
          </Button>
        </div>

        {/* View Controls */}
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-background/80 p-1 backdrop-blur-md shadow-xs">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAutoRotate((prev) => !prev)}
            title={autoRotate ? "Pause rotation" : "Auto rotate"}
            className={`size-7 ${autoRotate ? "text-primary" : "text-muted-foreground"}`}
          >
            <Play className="size-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={resetCamera}
            title="Reset camera view"
            className="size-7 text-muted-foreground"
          >
            <RotateCcw className="size-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsFullscreen((prev) => !prev)}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="size-7 text-muted-foreground"
          >
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </div>
      </div>

      {/* Bottom HUD Information */}
      <div className="pointer-events-none absolute bottom-4 left-4 right-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3 rounded-lg bg-background/80 px-3 py-1.5 backdrop-blur-md border shadow-xs w-fit">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-blue-500 shadow-[0_0_8px_#3b82f6]" />
            <span className="font-medium text-foreground">Knowledge Chunks</span>
          </span>
          <span>•</span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" />
            <span className="font-medium text-foreground">Persona Voice Moments</span>
          </span>
        </div>

        <div className="hidden sm:block rounded-lg bg-background/80 px-3 py-1.5 backdrop-blur-md border shadow-xs">
          Rotate: <kbd className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">Drag</kbd> •
          Pan: <kbd className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">Shift + Drag</kbd> •
          Zoom: <kbd className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">Scroll</kbd> •
          Inspect: <kbd className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">Click point</kbd>
        </div>
      </div>

      {/* Interactive Tooltip following hovered point */}
      {hoveredPoint && (
        <div
          className="pointer-events-none absolute z-30 w-72 -translate-x-1/2 -translate-y-full transform pb-3 transition-transform duration-75"
          style={{
            left: `${hoveredPoint.screenX}px`,
            top: `${hoveredPoint.screenY - 12}px`,
          }}
        >
          <Card className="border-border/80 bg-popover/95 p-3.5 text-xs shadow-xl backdrop-blur-md">
            <div className="flex items-center justify-between pb-1.5 border-b mb-2">
              <Badge
                variant="outline"
                className={`text-[10px] font-semibold gap-1 ${
                  hoveredPoint.point.type === "persona_voice"
                    ? "border-emerald-500/30 text-emerald-600 bg-emerald-500/10"
                    : "border-blue-500/30 text-blue-600 bg-blue-500/10"
                }`}
              >
                {hoveredPoint.point.type === "persona_voice" ? (
                  <>
                    <Mic className="size-2.5" />
                    <span>Persona Voice</span>
                  </>
                ) : (
                  <>
                    <Database className="size-2.5" />
                    <span>Document Chunk</span>
                  </>
                )}
              </Badge>

              {hoveredPoint.point.chunkIndex !== undefined && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  Chunk #{hoveredPoint.point.chunkIndex + 1}
                </span>
              )}
            </div>

            <p className="font-semibold text-foreground truncate mb-1">
              {hoveredPoint.point.title || hoveredPoint.point.source}
            </p>

            <p className="text-[11px] text-muted-foreground line-clamp-3 leading-relaxed font-sans mb-2.5">
              &quot;{hoveredPoint.point.preview}&quot;
            </p>

            <div className="flex items-center justify-between pt-1 border-t text-[10px] text-primary font-medium">
              <span>Click point to inspect</span>
              <ExternalLink className="size-3" />
            </div>
          </Card>
        </div>
      )}

      {/* Persona Voice Moment Preview Dialog */}
      <Dialog
        open={selectedVoicePoint !== null}
        onOpenChange={(open) => !open && setSelectedVoicePoint(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 bg-emerald-500/10 text-xs">
                <Mic className="size-3" />
                <span>Persona Voice Memory</span>
              </Badge>
            </div>
            <DialogTitle className="mt-2 text-base font-semibold">
              {selectedVoicePoint?.title || selectedVoicePoint?.source || "Voice Moment"}
            </DialogTitle>
            <DialogDescription>
              A synthetic voice training vector captured in the organization collection.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            <div className="rounded-xl border bg-muted/30 p-3.5 leading-relaxed text-foreground whitespace-pre-wrap">
              {selectedVoicePoint?.preview}
            </div>

            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>
                <span className="block text-[11px]">Vector ID</span>
                <span className="font-mono text-foreground font-medium truncate block">
                  {selectedVoicePoint?.id}
                </span>
              </div>
              <div>
                <span className="block text-[11px]">Source</span>
                <span className="font-medium text-foreground truncate block">
                  {selectedVoicePoint?.source}
                </span>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
