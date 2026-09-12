import {
  ARTIFACT_IMAGE_FAN_CARD,
  artifactImageFanSlots,
  type ImageMessageBlock,
  visibleArtifactImageFanItems,
} from "@rakazo/core";
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { cacheMobileArtifactUri, type MobileArtifactTarget } from "../lib/artifact-open";
import { t } from "../lib/i18n";
import { NativeSymbol } from "./native-symbol";

function useMobileArtifactUri(target: MobileArtifactTarget, artifactId: string, mimeType: string) {
  const [uri, setUri] = useState<string | null>(null);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    let cancelled = false;
    const requestTarget: MobileArtifactTarget =
      targetBotId !== undefined ? { botId: targetBotId } : { groupId: targetGroupId ?? "" };
    setUri(null);
    void cacheMobileArtifactUri(requestTarget, artifactId, mimeType)
      .then((next) => {
        if (!cancelled) setUri(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [artifactId, mimeType, targetBotId, targetGroupId]);

  return uri;
}

function FanCard({
  target,
  image,
  slot,
  stacked,
}: {
  target: MobileArtifactTarget;
  image: ImageMessageBlock;
  slot: { rotateDeg: number; offsetX: number; offsetY: number; zIndex: number };
  stacked: boolean;
}) {
  const tokens = mobileTokens();
  const uri = useMobileArtifactUri(target, image.artifactId, image.mimeType);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.card,
        {
          top: stacked ? 10 : 0,
          borderColor: tokens.border,
          backgroundColor: tokens.card,
          zIndex: slot.zIndex,
          transform: [
            { translateX: slot.offsetX },
            { translateY: slot.offsetY },
            { rotate: `${slot.rotateDeg}deg` },
          ],
        },
      ]}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.image} />
      ) : (
        <View style={[styles.placeholder, { backgroundColor: tokens.muted }]}>
          <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{image.name}</Text>
        </View>
      )}
    </View>
  );
}

export function ArtifactImageFan({
  target,
  images,
}: {
  target: MobileArtifactTarget;
  images: readonly ImageMessageBlock[];
}) {
  const tokens = mobileTokens();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const front = images.at(-1);
  const openImage = openIndex !== null ? images[openIndex] : undefined;
  const openUri = useMobileArtifactUri(
    target,
    openImage?.artifactId ?? front?.artifactId ?? "",
    openImage?.mimeType ?? front?.mimeType ?? "image/png",
  );

  if (!front) return null;

  const visibleCards = visibleArtifactImageFanItems(images);
  const slots = artifactImageFanSlots(visibleCards.length);
  const stacked = images.length > 1;

  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={stacked ? t("{count} images", { count: images.length }) : front.name}
        onPress={() => setOpenIndex(images.length - 1)}
        style={stacked ? styles.fan : styles.single}
      >
        {stacked ? (
          visibleCards.map((image, index) => {
            const slot = slots[index];
            if (!slot) return null;
            return (
              <FanCard key={image.artifactId} target={target} image={image} slot={slot} stacked />
            );
          })
        ) : (
          <FanCard
            target={target}
            image={front}
            slot={{ rotateDeg: 0, offsetX: 0, offsetY: 0, zIndex: 1 }}
            stacked={false}
          />
        )}
      </Pressable>
      <Modal
        visible={openIndex !== null}
        animationType="fade"
        onRequestClose={() => setOpenIndex(null)}
      >
        <View style={[styles.modal, { backgroundColor: tokens.background }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Close image preview")}
            onPress={() => setOpenIndex(null)}
            style={styles.close}
          >
            <NativeSymbol ios="xmark" android="close" />
          </Pressable>
          {openIndex !== null && openIndex > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Previous image")}
              onPress={() => setOpenIndex(openIndex - 1)}
              style={[styles.nav, styles.navPrev]}
            >
              <NativeSymbol ios="chevron.left" android="chevron-back" />
            </Pressable>
          ) : null}
          {openIndex !== null && openIndex < images.length - 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Next image")}
              onPress={() => setOpenIndex(openIndex + 1)}
              style={[styles.nav, styles.navNext]}
            >
              <NativeSymbol ios="chevron.right" android="chevron-forward" />
            </Pressable>
          ) : null}
          {openUri ? (
            <Image source={{ uri: openUri }} style={styles.preview} resizeMode="contain" />
          ) : (
            <Text style={{ color: tokens.mutedForeground }}>{openImage?.name ?? front.name}</Text>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fan: {
    width: ARTIFACT_IMAGE_FAN_CARD.width + 36,
    height: ARTIFACT_IMAGE_FAN_CARD.height + 28,
  },
  single: {
    width: ARTIFACT_IMAGE_FAN_CARD.width,
    height: ARTIFACT_IMAGE_FAN_CARD.height,
  },
  card: {
    position: "absolute",
    right: 0,
    top: 10,
    width: ARTIFACT_IMAGE_FAN_CARD.width,
    height: ARTIFACT_IMAGE_FAN_CARD.height,
    overflow: "hidden",
    borderWidth: 1,
    borderRadius: 16,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  placeholder: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modal: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  preview: {
    width: "100%",
    height: "80%",
  },
  close: {
    position: "absolute",
    top: 48,
    right: 16,
    zIndex: 2,
    padding: 8,
  },
  nav: {
    position: "absolute",
    top: "50%",
    zIndex: 2,
    padding: 8,
  },
  navPrev: {
    left: 8,
  },
  navNext: {
    right: 8,
  },
});
