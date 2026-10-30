-- Корзинка: сколько купить (условные единицы — пачки, кг, бутылки…)
alter table k_items add column if not exists qty int;
