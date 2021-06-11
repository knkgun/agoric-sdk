// @ts-check
import { assert } from '@agoric/assert';
import '../../types';
import { insistVatDeliveryResult } from '../../message';
import { makeTranscriptManager } from './transcript';

// We use vat-centric terminology here, so "inbound" means "into a vat",
// always from the kernel. Conversely "outbound" means "out of a vat", into
// the local kernel.

// The mapVatSlotToKernelSlot() function is used to translate slot references
// on the vat->kernel pathway. mapKernelToVatSlot() is used for kernel->vat.

// The terms "import" and "export" are also vat-centric. "import" means
// something a Vat has imported (from the kernel). Imports are tracked in a
// kernel-side table for each Vat, which is populated by the kernel as a
// message is delivered. Each import is represented inside the Vat as a
// Presence (at least when using liveSlots).

// "exports" are callable objects inside the Vat which it has made
// available to the kernel (so that other vats can invoke it). The exports
// table is managed by userspace code inside the vat. The kernel tables map
// one vat's import IDs (o-NN) to a kernel object ID (koNN) in the
// vatKeeper's state.vatSlotToKernelSlot table. To make sure we use the
// same importID each time, we also need to keep a reverse table:
// kernelSlotToVatSlot maps them back.

// The vat sees "vat slots" (object references) as the arguments of
// syscall/dispatch functions. These take on the following forms (where
// "NN" is an integer):

// o+NN : an object ref allocated by this Vat, hence an export
// o-NN : an object ref allocated by the kernel, an imported object
// p-NN : a promise ref allocated by the kernel
// p+NN : a promise ref allocated by this vat
// d-NN : a device ref allocated by the kernel, imported

// Within the kernel, we use "kernel slots", with the following forms:

// koNN : an object reference
// kpNN : a promise reference
// kdNN : a device reference

// The vatManager is responsible for translating vat slots into kernel
// slots on the outbound (syscall) path, and kernel slots back into vat
// slots on the inbound (dispatch) path.

/**
 *
 * @typedef { { getManager: (shutdown: () => Promise<void>) => VatManager,
 *              syscallFromWorker: (vso: VatSyscallObject) => VatSyscallResult,
 *              setDeliverToWorker: (dtw: unknown) => void,
 *            } } ManagerKit
 *
 */

/**
 * This generic helper runs on the manager side. It handles transcript
 * record/replay, and errors in the manager-specific code.
 *
 * Create me at the beginning of the manager factory, with a vatKeeper and
 * vatSyscallHandler.
 *
 * When you build the handler that accepts syscall requests from the worker,
 * that handler should call my { syscallFromWorker } function, so I can
 * forward those requests to vatSyscallHandler (after going through the
 * transcript).
 *
 * At some point, you must give me a way to send deliveries to the worker, by
 * calling setDeliverToWorker. This usually happens after the worker
 * connection is established.
 *
 * At the end of the factory, use my getManager(shutdown) method to create,
 * harden, and return the VatManager object. Give me a manager-specific
 * shutdown function which I can include in the VatManager.
 *
 *
 * deliverToWorker is expected to accept a VatDeliveryObject and return a
 * VatDeliveryResult, or a promise for one. It is allowed to throw or reject,
 * in which case the caller gets a error-bearing VDR, which will probably
 * kill the vat. For remote (subprocess/thread) workers, deliverToWorker
 * should be a function that serializes the VDO and sends it over the wire,
 * and waits for a response, so it might reject if the child process has
 * died. For a local worker, deliverToWorker can be the liveslots 'dispatch'
 * method (which runs synchronously and throws if liveslots has an error).
 *
 * vatSyscallHandler should be the same 'vatSyscallHandler' given to a
 * managerFactory. It is expected to accept a VatSyscallObject and return a
 * (synchronous) VatSyscallResult, never throwing.
 *
 * The returned syscallFromWorker function should be called when the worker
 * wants to make a syscall. It accepts a VatSyscallObject and will return a
 * (synchronous) VatSyscallResult, never throwing. For remote workers, this
 * should be called from a handler that receives a syscall message from the
 * child process.
 *
 * The returned getManager() function will return a VatManager suitable for
 * handing to the kernel, which can use it to send deliveries to the vat.
 *
 * @param { string } vatID
 * @param { KernelKeeper } kernelKeeper
 * @param { KernelSlog } kernelSlog
 * @param { (vso: VatSyscallObject) => VatSyscallResult } vatSyscallHandler
 * @param { boolean } workerCanBlock
 * @returns { ManagerKit }
 */

function makeManagerKit(
  vatID,
  kernelSlog,
  kernelKeeper,
  vatSyscallHandler,
  workerCanBlock,
  compareSyscalls,
  useTranscript,
) {
  assert(kernelSlog);
  const vatKeeper = kernelKeeper.provideVatKeeper(vatID);
  let transcriptManager;
  if (useTranscript) {
    transcriptManager = makeTranscriptManager(
      vatKeeper,
      vatID,
      compareSyscalls,
    );
  }

  /** @type { (delivery: VatDeliveryObject) => Promise<VatDeliveryResult> } */
  let deliverToWorker;

  /**
   * @param { (delivery: VatDeliveryObject) => Promise<VatDeliveryResult> } dtw
   */
  function setDeliverToWorker(dtw) {
    assert(!deliverToWorker, `setDeliverToWorker called twice`);
    deliverToWorker = dtw;
  }

  /**
   *
   * @param { VatDeliveryObject } delivery
   * @returns { Promise<VatDeliveryResult> }
   */
  async function deliver(delivery) {
    if (transcriptManager) {
      transcriptManager.startDispatch(delivery);
    }
    /** @type { VatDeliveryResult } */
    const status = await deliverToWorker(delivery).catch(err =>
      harden(['error', err.message, null]),
    );
    insistVatDeliveryResult(status);
    // TODO: if the dispatch failed for whatever reason, and we choose to
    // destroy the vat, change what we do with the transcript here.
    if (transcriptManager) {
      transcriptManager.finishDispatch();
    }
    return status;
  }

  async function replayOneDelivery(delivery, expectedSyscalls, deliveryNum) {
    assert(transcriptManager, `delivery replay with no transcript`);
    transcriptManager.startReplay();
    transcriptManager.startReplayDelivery(expectedSyscalls);
    kernelSlog.write({
      type: 'start-replay-delivery',
      vatID,
      delivery,
      deliveryNum,
    });
    await deliver(delivery);
    transcriptManager.finishReplayDelivery();
    transcriptManager.checkReplayError();
    transcriptManager.finishReplay();
    kernelSlog.write({ type: 'finish-replay-delivery', vatID, deliveryNum });
  }

  async function replayTranscript() {
    if (transcriptManager) {
      const total = vatKeeper.vatStats().transcriptCount;
      kernelSlog.write({ type: 'start-replay', vatID, deliveries: total });
      let deliveryNum = 0;
      for (const t of vatKeeper.getTranscript()) {
        // if (deliveryNum % 100 === 0) {
        //   console.debug(`replay vatID:${vatID} deliveryNum:${deliveryNum} / ${total}`);
        // }
        //
        // eslint-disable-next-line no-await-in-loop
        await replayOneDelivery(t.d, t.syscalls, deliveryNum);
        deliveryNum += 1;
      }
      transcriptManager.checkReplayError();
      kernelSlog.write({ type: 'finish-replay', vatID });
    }
  }

  /**
   * vatSyscallObject is an array that starts with the syscall name ('send',
   * 'subscribe', etc) followed by all the positional arguments of the
   * syscall, designed for transport across a manager-worker link (serialized
   * bytes over a socket or pipe, postMessage to an in-process Worker, or
   * just direct).
   *
   * @param { VatSyscallObject } vso
   * @returns { VatSyscallResult }
   */
  function syscallFromWorker(vso) {
    if (transcriptManager && transcriptManager.inReplay()) {
      // We're replaying old messages to bring the vat's internal state
      // up-to-date. It will make syscalls like a puppy chasing rabbits in
      // its sleep. Gently prevent their twitching paws from doing anything.

      // but if the puppy deviates one inch from previous twitches, explode
      const data = transcriptManager.simulateSyscall(vso);
      return harden(['ok', data]);
    }

    const vres = vatSyscallHandler(vso);
    // vres is ['error', reason] or ['ok', null] or ['ok', capdata] or ['ok', string]
    const [successFlag, data] = vres;
    if (successFlag === 'ok') {
      if (data && !workerCanBlock) {
        console.log(`warning: syscall returns data, but worker cannot get it`);
      }
      if (transcriptManager) {
        transcriptManager.addSyscall(vso, data);
      }
    }
    return vres;
  }

  /**
   *
   * @param { () => Promise<void>} shutdown
   * @returns { VatManager }
   */
  function getManager(shutdown) {
    return harden({ replayTranscript, replayOneDelivery, deliver, shutdown });
  }

  return harden({ getManager, syscallFromWorker, setDeliverToWorker });
}
harden(makeManagerKit);
export { makeManagerKit };