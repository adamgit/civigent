import type { BlockDropEdge, BlockOwnerAddress } from "./block-drag-model";
import type { SectionTransferService, TransferResult } from "./section-transfer";

export interface BodyMoveCommitRequest {
  readonly sourceFragmentKey: string;
  readonly targetFragmentKey: string;
  readonly sourceAddress: BlockOwnerAddress;
  readonly targetAddress: BlockOwnerAddress;
  readonly edge: BlockDropEdge;
  readonly serializedNode: string;
}

export function commitNeighbourEditorBodyMove(
  transfer: SectionTransferService,
  req: BodyMoveCommitRequest,
): Promise<TransferResult> {
  return transfer.executeBodyMove(req);
}

export function commitStaticSectionBodyMove(
  transfer: SectionTransferService,
  req: BodyMoveCommitRequest,
): Promise<TransferResult> {
  return transfer.executeBodyMove(req);
}

export function commitIdentityHeadingOutlineMove(
  transfer: SectionTransferService,
  req: {
    sourceHeadingPath: string[];
    targetHeadingPath: string[];
    targetFragmentKey: string;
    position: BlockDropEdge;
  },
): Promise<TransferResult> {
  return transfer.executeOutlineMove(req);
}

export function isHostGripSessionActive(): boolean {
  return document.documentElement.classList.contains("grip-drag-active");
}
