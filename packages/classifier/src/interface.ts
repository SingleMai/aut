import type { Classifier as ClassifierShape } from "@aut/protocol";
import { Context } from "effect";

export class Classifier extends Context.Tag("@aut/classifier/Classifier")<
  Classifier,
  ClassifierShape
>() {}

export {
  type Classifier as ClassifierShape,
  ClassifierError,
  type ClassifierErrorCode,
} from "@aut/protocol";
