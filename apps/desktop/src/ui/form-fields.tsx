import { Select, TextArea, TextField } from "@radix-ui/themes";
import { type ComponentProps, type ReactNode, type Ref, useId } from "react";
import { useFormFeedback } from "./configuration-form.js";

type FieldLayout = { label: string; wide?: boolean; fieldName?: string | undefined };
type Control = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };

function Field({
  label,
  fieldName,
  wide,
  children,
}: FieldLayout & { children: (control: Control) => ReactNode }) {
  const id = useId();
  const { errors } = useFormFeedback();
  const message = fieldName && errors[fieldName];
  return (
    <div className={wide ? "field field-wide" : "field"} data-field={fieldName}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        ...(message && { "aria-invalid": true, "aria-describedby": `${id}-error` }),
      })}
      {message && (
        <p id={`${id}-error`} className="field-error">
          {message}
        </p>
      )}
    </div>
  );
}

export function InputField({
  label,
  wide = false,
  fieldName,
  ...input
}: FieldLayout & Omit<TextField.RootProps, "id"> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <Field label={label} wide={wide} fieldName={fieldName ?? input.name}>
      {(control) => <TextField.Root {...input} {...control} />}
    </Field>
  );
}

export function TextAreaField({
  label,
  wide = false,
  ...input
}: FieldLayout & Omit<ComponentProps<typeof TextArea>, "id">) {
  return (
    <Field label={label} wide={wide} fieldName={input.name}>
      {(control) => <TextArea rows={3} resize="vertical" {...input} {...control} />}
    </Field>
  );
}

export function SelectField({
  label,
  wide = false,
  placeholder,
  children,
  ...select
}: FieldLayout & Select.RootProps & { placeholder?: string }) {
  return (
    <Field label={label} wide={wide} fieldName={select.name}>
      {(control) => (
        <Select.Root {...select}>
          <Select.Trigger
            {...control}
            aria-label={label}
            {...(placeholder !== undefined && { placeholder })}
          />
          <Select.Content position="popper">{children}</Select.Content>
        </Select.Root>
      )}
    </Field>
  );
}
