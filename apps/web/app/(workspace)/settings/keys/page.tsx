"use client";
import PlatformKeys from "../../../platform-keys";
import OwnersOnly from "../owners-only";
export default function Keys() {
  return (
    <OwnersOnly>
      <PlatformKeys />
    </OwnersOnly>
  );
}
