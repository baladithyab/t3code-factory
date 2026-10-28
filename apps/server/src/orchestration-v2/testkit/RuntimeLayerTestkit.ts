import * as Layer from "effect/Layer";

import * as FactoryDeliveryService from "../../factory/FactoryDeliveryService.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";

/** The runtime without a live delivery service: these tests never run a delivery effect. */
export const layer = RuntimeLayer.layer.pipe(
  Layer.provide(Layer.mock(FactoryDeliveryService.FactoryDeliveryService)({})),
);
