CREATE TABLE broken_halfway (id integer PRIMARY KEY);

-- Andra satsen sprängs: tabellen ovan får inte finnas kvar efteråt.
INSERT INTO table_som_inte_finns (id) VALUES (1);
