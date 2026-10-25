import Anthropic from "@anthropic-ai/sdk";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { register } from "@arizeai/phoenix-otel";

const collectorEndpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;
if (!collectorEndpoint) {
  throw new Error(
    "PHOENIX_COLLECTOR_ENDPOINT is required. Copy .env.example to .env and set the Phoenix variables.",
  );
}

export const INSTRUMENTATION_PROJECT = "real-eon-memory-verdict";

export const tracerProvider = register({
  projectName: INSTRUMENTATION_PROJECT,
  url: collectorEndpoint,
  batch: false,
  global: false,
});

const instrumentation = new AnthropicInstrumentation({
  tracerProvider,
});
instrumentation.manuallyInstrument(Anthropic);
