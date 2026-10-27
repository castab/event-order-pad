-- The menu moves out of code: each row is one flavor, container or topping.
-- data repeats its category so every entry stays self-describing on its own.
CREATE TABLE fionas_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('flavor', 'container', 'topping')),
  position INTEGER NOT NULL CHECK (position >= 0),
  data JSONB NOT NULL,
  CHECK (jsonb_typeof(data) = 'object'),
  -- COALESCE, because a CHECK that evaluates to NULL would let a missing key through.
  CHECK (COALESCE(data->>'category' = category, false)),
  CHECK (COALESCE(jsonb_typeof(data->'displayName') = 'string', false))
);
CREATE UNIQUE INDEX fionas_choices_name_key ON fionas_choices (category, lower(data->>'displayName'));
CREATE INDEX fionas_choices_position_idx ON fionas_choices (category, position);

-- Bumped by every menu change so builders notice without reloading.
ALTER TABLE station ADD COLUMN menu_revision BIGINT NOT NULL DEFAULT 0;

-- The menu that was hard-coded until now, in the same order.
INSERT INTO fionas_choices (category, position, data) VALUES
  ('flavor', 0, '{"category": "flavor", "displayName": "Chocolate"}'),
  ('flavor', 1, '{"category": "flavor", "displayName": "Vanilla"}'),
  ('flavor', 2, '{"category": "flavor", "displayName": "Strawberry"}'),
  ('flavor', 3, '{"category": "flavor", "displayName": "Chocolate Chip"}'),
  ('container', 0, '{"category": "container", "displayName": "Cup"}'),
  ('container', 1, '{"category": "container", "displayName": "Cake Cone"}'),
  ('container', 2, '{"category": "container", "displayName": "Sugar Cone"}'),
  ('topping', 0, '{"category": "topping", "displayName": "Whipped cream"}'),
  ('topping', 1, '{"category": "topping", "displayName": "Gummy Bears"}'),
  ('topping', 2, '{"category": "topping", "displayName": "Caramel Sauce"}'),
  ('topping', 3, '{"category": "topping", "displayName": "Chocolate Sauce"}'),
  ('topping', 4, '{"category": "topping", "displayName": "Sliced Almonds"}'),
  ('topping', 5, '{"category": "topping", "displayName": "Maraschino Cherries"}'),
  ('topping', 6, '{"category": "topping", "displayName": "Rainbow Sprinkles"}'),
  ('topping', 7, '{"category": "topping", "displayName": "Chocolate Sprinkles"}');
